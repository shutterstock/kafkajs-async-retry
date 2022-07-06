import EventEmitter from "events";
import {
  EachBatchHandler,
  EachBatchPayload,
  EachMessageHandler,
  EachMessagePayload,
  IHeaders,
  KafkaMessage,
  Producer,
  KafkaJSNonRetriableError,
} from "kafkajs";

/**
 * Different strategies for naming retry topics
 */
export enum RetryTopicNaming {
  /**
   * Retry topics are named in succession based on the number of retries (e.g. `${consumerGroup}-retry-1`, `${consumerGroup}-retry-2`, etc.)
   */
  ATTEMPT_BASED = "attempt",
  /**
   * Retry topics are named based on the configured delay in seconds (e.g. `${consumerGroup}-retry-5s`, `${consumerGroup}-retry-30s`, etc.)
   */
  DELAY_BASED = "delay",
}

/**
 * Events that can be subscribed to for different retry-handling operations
 */
export enum AsyncRetryEvent {
  /**
   * Fired when a message is sent to a retry topic
   */
  RETRY = "retry",
  /**
   * Fired when a message is sent to the dead-letter topic
   */
  DEAD_LETTER = "dead-letter",
}

export interface AsyncRetryConfig {
  /** The consumer group ID that this async retry helper is handling messages for */
  groupId: string;
  /** A previously configured (and connected) producer that can be used to publish messages into the appropriate delay and retry topics */
  producer: Pick<Producer, "send">;
  /** The maximum number of retries for a given message (defaults to 5) */
  maxRetries?: number;
  /** The amount of time (in milliseconds) to block an `eachMessage` call while waiting until a retry message is ready to be processed. Waits above this amount will result in the consumer pausing on the topic/partition until the message is ready. */
  maxWaitTime?: number;
  /** A series of delays (in seconds) that will be used for each corresponding retry attempt */
  retryDelays?: [number, ...number[]];
  /** Strategy for how retry topics are named */
  retryTopicNaming?: RetryTopicNaming;
}

export interface AsyncRetryMessageDetails {
  /** Whether this message has been routed through an async retry or not */
  isRetry: boolean;
  /** Whether this message is ready to be processed or not */
  isReady: boolean;
  /** The original topic the message came from */
  originalTopic: string;
  /** The number of attempts the message has had so far */
  previousAttempts: number;
  /** The earliest time the message should be processed */
  processTime: Date;
}

/**
 * Utility type for Arrays with a minimum length of 1
 */
type NonEmptyArray<T> = [T, ...T[]];

export type AsyncRetryAwareEachBatchPayload = EachBatchPayload & {
  /**
   * Given a {KafkaMessage} object, returns details relevant to async retry handling
   */
  asyncRetryMessageDetails: (message: KafkaMessage) => AsyncRetryMessageDetails;
  /**
   * Handles sending a message to the appropriate retry or dead-letter topic based on how many retries have already been attempted as well as the {Error} object passed in
   */
  messageFailureHandler: (error: Error, message: KafkaMessage) => Promise<void>;
};

export type AsyncRetryAwareBatchHandler = (
  payload: AsyncRetryAwareEachBatchPayload
) => Promise<void>;

interface ARHeaders {
  /** the original topic (before any async retries) the message came from */
  top: string;
  /** the earliest time (expressed as milliseconds since epoch) when the message is expected to be retried */
  ttl: number;
  /** the number of times this message has already been attempted */
  att: number;
}

/**
 * The full set of data provided to the {AsyncRetryAwareEachMessageHandler} when processing a message (including details specific to async retry handling)
 */
export type AsyncRetryAwareEachMessagePayload = EachMessagePayload & {
  /**
   * Whether this message attempt is a retry or not (will be false on the first attempt and true on all subsequent attempts)
   */
  isRetry: boolean;
  /**
   * What topic the message was originally published to before any retries
   */
  originalTopic: string;
  /**
   * How many attempts this message has had so far (will be 0 on the first attempt and 1 on the second attempt, etc.)
   */
  previousAttempts: number;
  /**
   * The earliest time (expressed as a {Date} object) this message should be processed. For the first attempt, this will always be "now". For subsequent attempts, this will always be something <= "now" (potentially in the past if the consumer is behind where it should be)
   */
  processTime: Date;
};

export type AsyncRetryAwareMessageHandler = (
  payload: AsyncRetryAwareEachMessagePayload
) => Promise<void>;

function hasOwnProperty<X extends object, Y extends PropertyKey>(
  obj: X,
  prop: Y,
  type: string
): obj is X & Record<Y, unknown> {
  return (
    Object.prototype.hasOwnProperty.call(obj, prop) &&
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    typeof (obj as any)[prop] === type
  );
}

function isValidARHeaders(value: unknown): value is ARHeaders {
  return (
    !!value &&
    typeof value === "object" &&
    hasOwnProperty(value, "top", "string") &&
    hasOwnProperty(value, "ttl", "number") &&
    hasOwnProperty(value, "att", "number")
  );
}

function extractAsyncRetryHeaders(
  headers: KafkaMessage["headers"]
): ARHeaders | undefined {
  if (!headers || !("asyncRetry" in headers) || !headers["asyncRetry"]) return;

  try {
    const arHeaders = JSON.parse(String(headers["asyncRetry"])) as unknown;
    if (!isValidARHeaders(arHeaders)) return;
    return arHeaders as ARHeaders;
  } catch (err: unknown) {
    return; // ignore malformed headers
  }
}

// we are extending KafkaJSError here to avoid noisy logging that KafkaJS does for non-KafkaJS errors
class WaitBeforeProcessing extends KafkaJSNonRetriableError {
  constructor(
    public readonly waitMs: number,
    public readonly topic: string,
    public readonly partition: number
  ) {
    super(
      `Waiting ${waitMs}ms before resuming processing messages from ${topic}/${partition}`
    );
    Object.setPrototypeOf(this, WaitBeforeProcessing.prototype);
  }
}

/**
 * A custom exception that will result in the message being sent to the dead-letter topic
 */
export class DeadLetter extends Error {
  constructor(reason: string) {
    super(`Sending message to dead letter topic: ${reason}`);
    Object.setPrototypeOf(this, DeadLetter.prototype);
  }
}

export type EventPayload = {
  /** The message being retried or dead-letter'd */
  message: KafkaMessage;
  /** Information about the retry-state of the message */
  details: Omit<AsyncRetryMessageDetails, "isReady">;
  /** The Error that is triggering the message to be retried or dead-letter'd */
  error: unknown;
  /** The destination topic for the current retry attempt or dead-letter topic name as applicable */
  topic: string;
};

type TopicPartition = `${string}:${number}`;

/**
 * A helper that can be used with KafkaJS to facilitate sending messages to retry and/or dead-letter topics so that processing of the primary topics can proceed without being blocked by problematic messages.
 */
export default class AsyncRetryHelper {
  /** pattern that can be used when subscribing to all relevant retry topics for the consumer group */
  public readonly retryTopicPattern: RegExp;

  /** the number of seconds to wait for each retry attempt (the first retry being the zero-th number in this array) */
  public readonly retryDelays: NonEmptyArray<number>;

  /** The topic that messages will be delivered to after all retry attempts are exhausted */
  public readonly deadLetterTopic: string;

  private readonly producer: Pick<Producer, "send">;
  private readonly maxRetries: number;
  private readonly maxWaitTime: number;
  private readonly _retryTopics: NonEmptyArray<string>;
  private readonly eventEmitter = new EventEmitter();

  private pausedTopicPartitions: Set<TopicPartition> = new Set();

  /**
   * The current set of retry topics that are in use by this {AsyncRetryHelper} instance
   */
  public get retryTopics(): string[] {
    return [...new Set([...this._retryTopics])];
  }

  /**
   * Create a new AsyncRetryHelper instance
   * @param {AsyncRetryConfig} param0
   */
  constructor({
    maxRetries = 5,
    retryDelays = [5],
    maxWaitTime = 3000, // 3 seconds
    retryTopicNaming = RetryTopicNaming.ATTEMPT_BASED,
    ...config
  }: AsyncRetryConfig) {
    if (maxRetries <= 0) {
      throw new Error("maxRetries must be > 0");
    }
    if (retryDelays.length > maxRetries) {
      throw new Error(
        `retryDelays (${retryDelays}) doesn't need to be longer than maxRetries (${maxRetries})`
      );
    }

    this.producer = config.producer;
    this.maxRetries = maxRetries;
    this.maxWaitTime = maxWaitTime;

    // here, we expand the provided array to cover up to the max retries, as specified (the final retry time is used for any extra retries)
    this.retryDelays = [...Array(maxRetries).keys()].map((i) => {
      return retryDelays[i] || retryDelays[retryDelays.length - 1];
    }) as NonEmptyArray<number>;

    const retryTopicPrefix = `${config.groupId}-retry-`;
    // format a retry topic for each configured retry delay
    this._retryTopics = this.retryDelays
      .map((delay, i) => {
        return retryTopicNaming === RetryTopicNaming.ATTEMPT_BASED
          ? String(i + 1)
          : `${delay}s`;
      })
      .map((suffix) => `${retryTopicPrefix}${suffix}`) as NonEmptyArray<string>;

    this.deadLetterTopic = `${config.groupId}-dlq`;
    this.retryTopicPattern = new RegExp(`^${retryTopicPrefix}\\d+s?$`);
  }

  /**
   * Registers a callback function that will be called on the specified event.
   * @param event The name of the event
   * @param listener The callback function
   * @returns  {AsyncRetryHelper}
   */
  public on(
    event: AsyncRetryEvent | `${AsyncRetryEvent}`,
    listener: (payload: EventPayload) => void
  ): this {
    this.eventEmitter.on(event, listener);
    return this;
  }

  /**
   * Wraps the provided handler with a handler that will send the message to the appropriate retry (or dead-letter) topic if an exception is thrown
   * @param {AsyncRetryAwareMessageHandler} handler - your message handler that will be provided with a few extra parameters relevant to the async retry process
   * @returns {EachMessageHandler} - a standard message handler that can be passed to a KafkaJS consumer instance
   */
  public eachMessage(
    handler: AsyncRetryAwareMessageHandler
  ): EachMessageHandler {
    return async (payload) => {
      const { isReady, ...details } = this.asyncRetryMessageDetails(
        payload.message.headers || {},
        payload.topic
      );
      if (!isReady) {
        await this.pauseUntilMessageIsReady(
          payload.topic,
          payload.partition,
          details.processTime,
          payload.pause
        );
      }
      try {
        return await handler({ ...payload, ...details });
      } catch (error: unknown) {
        await this.handleMessageFailure({
          error: error instanceof Error ? error : new Error(String(error)),
          message: payload.message,
          details,
        });
      }
    };
  }

  /**
   * Wraps the provided handler with a handler that will provide some extra callback functions for dealing with message processing errors and retries
   * @param {AsyncRetryAwareBatchHandler} handler - your batch handler that will be provided with a few extra parameters relevant to the async retry process
   * @returns {EachBatchHandler} - a standard batch handler that can be passed to a KafkaJS consumer instance
   */
  public eachBatch(handler: AsyncRetryAwareBatchHandler): EachBatchHandler {
    return async (payload) => {
      // callbacks related to async retries
      const asyncRetryMessageDetails = (message: KafkaMessage) =>
        this.asyncRetryMessageDetails(message.headers, payload.batch.topic);
      const messageFailureHandler = (error: Error, message: KafkaMessage) =>
        this.handleMessageFailure({
          error,
          message,
          details: this.asyncRetryMessageDetails(
            message.headers || {},
            payload.batch.topic
          ),
        });

      if (payload.batch.topic.match(this.retryTopicPattern)) {
        // we need to only provide messages that are ready to be processed to the message handler
        const allMessages = [...payload.batch.messages];

        // we do a while loop here in case any subsequent batches of messages become "ready" while the prior set is being processed
        while (allMessages.length > 0) {
          const readyMessages = this.extractReadyMessages(
            payload.batch.topic,
            allMessages
          );
          if (!readyMessages) {
            const details = this.asyncRetryMessageDetails(
              allMessages[0].headers,
              payload.batch.topic
            );
            await this.pauseUntilMessageIsReady(
              payload.batch.topic,
              payload.batch.partition,
              details.processTime,
              payload.pause
            );
            continue;
          }
          await handler({
            ...payload,
            batch: { ...payload.batch, messages: readyMessages },
            asyncRetryMessageDetails,
            messageFailureHandler,
          });
        }
        return;
      }

      // here's processing for the normal (non-retried) messages
      await handler({
        ...payload,
        asyncRetryMessageDetails,
        messageFailureHandler,
      });
    };
  }

  private extractReadyMessages(
    topic: string,
    messages: KafkaMessage[]
  ): NonEmptyArray<KafkaMessage> | undefined {
    // we want to grab a contiguous series of "ready" messages and leave the rest as-is
    const firstNotReady = messages.findIndex(
      (m) => !this.asyncRetryMessageDetails(m.headers, topic).isReady
    );
    const readyMessages = messages.splice(
      0,
      firstNotReady === -1 ? messages.length : firstNotReady
    );
    return readyMessages.length > 0
      ? (readyMessages as NonEmptyArray<KafkaMessage>)
      : undefined;
  }

  private pauseUntilMessageIsReady(
    topic: string,
    partition: number,
    processTime: Date,
    pause: () => () => void
  ): Promise<void> {
    const waitTime = processTime.getTime() - Date.now();
    if (waitTime < this.maxWaitTime) {
      return new Promise((resolve) => setTimeout(resolve, waitTime).unref());
    }
    const topicPartition: TopicPartition = `${topic}:${partition}`;

    const alreadyPaused = this.pausedTopicPartitions.has(topicPartition);

    if (!alreadyPaused) {
      const resume = pause();
      this.pausedTopicPartitions.add(topicPartition);
      setTimeout(() => {
        resume();
        this.pausedTopicPartitions.delete(topicPartition);
      }, waitTime).unref();
    }

    // this returns control to KafkaJS while we wait for the scheduled timeout to fire
    throw new WaitBeforeProcessing(waitTime, topic, partition);
  }

  private asyncRetryMessageDetails(
    headers: KafkaMessage["headers"],
    topic: string
  ): AsyncRetryMessageDetails {
    const arHeaders = extractAsyncRetryHeaders(headers);
    if (arHeaders) {
      return {
        isRetry: true,
        previousAttempts: arHeaders.att,
        originalTopic: arHeaders.top,
        processTime: new Date(arHeaders.ttl),
        isReady: arHeaders.ttl <= Date.now(),
      };
    }
    return {
      isRetry: false,
      previousAttempts: 0,
      originalTopic: topic,
      processTime: new Date(),
      isReady: true,
    };
  }

  private prepareAsyncRetryHeaders(
    details: Pick<
      AsyncRetryMessageDetails,
      "previousAttempts" | "originalTopic"
    >
  ): IHeaders {
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const ttl = Date.now() + this.retryDelays[details.previousAttempts]! * 1000;
    const headers: ARHeaders = {
      ttl,
      top: details.originalTopic,
      att: details.previousAttempts + 1,
    };
    return { asyncRetry: Buffer.from(JSON.stringify(headers)) };
  }

  private async handleMessageFailure({
    message,
    details,
    error,
  }: Omit<EventPayload, "topic">) {
    const shouldDeadLetter =
      error instanceof DeadLetter ||
      details.previousAttempts >= this.maxRetries;
    let nextTopic: string | undefined;
    let headers = {};
    if (shouldDeadLetter) {
      nextTopic = this.deadLetterTopic;
    } else {
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      nextTopic = this._retryTopics[details.previousAttempts]!;
      headers = this.prepareAsyncRetryHeaders(details);
    }
    await this.producer.send({
      topic: nextTopic,
      messages: [
        {
          key: message.key,
          value: message.value,
          headers: {
            ...(message.headers || {}),
            ...headers,
          },
        },
      ],
    });

    this.eventEmitter.emit(
      shouldDeadLetter ? AsyncRetryEvent.DEAD_LETTER : AsyncRetryEvent.RETRY,
      { message, details, error, topic: nextTopic }
    );
  }
}
