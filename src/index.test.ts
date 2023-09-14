/* eslint-disable @typescript-eslint/no-non-null-assertion */
import { describe, expect, it, jest } from "@jest/globals";
import type {
  EachBatchPayload,
  EachMessagePayload,
  KafkaMessage,
  Producer,
} from "kafkajs";
import AsyncRetryHelper, {
  AsyncRetryAwareBatchHandler,
  AsyncRetryConfig,
  DeadLetter,
  RetryTopicNaming,
} from ".";

jest.useFakeTimers();
jest.spyOn(global, "setTimeout");

const mockProducer = {
  send: jest.fn<Producer["send"]>(),
};
const resume = jest.fn();
const pause = jest.fn<EachMessagePayload["pause"]>().mockReturnValue(resume);

const validConfig: AsyncRetryConfig = {
  groupId: "test-group",
  maxRetries: 5,
  retryTopicNaming: RetryTopicNaming.DELAY_BASED,
  producer: mockProducer,
};
describe("constructor", () => {
  it("throws if maxRetries is invalid", () => {
    expect.assertions(1);
    expect(
      () => new AsyncRetryHelper({ ...validConfig, maxRetries: -1 }),
    ).toThrow();
  });
  it("throws if retryDelays exceeds maxRetries", () => {
    expect.assertions(1);
    expect(
      () =>
        new AsyncRetryHelper({
          ...validConfig,
          retryDelays: [1, 2],
          maxRetries: 1,
        }),
    ).toThrow();
  });
  it("accepts fewer retry delays than max retries", () => {
    expect.assertions(2);
    const subject = new AsyncRetryHelper({
      ...validConfig,
      retryDelays: [1, 3],
      maxRetries: 3,
    });
    expect(subject).toBeInstanceOf(AsyncRetryHelper);
    expect(subject.retryDelays).toEqual([1, 3, 3]);
  });
  it("creates only the unique retry topics it needs", () => {
    expect.assertions(1);
    const subject = new AsyncRetryHelper({
      ...validConfig,
      retryDelays: [1, 3, 1],
      maxRetries: 3,
    });
    expect([...subject.retryTopics].sort()).toEqual([
      "test-group-retry-1s",
      "test-group-retry-3s",
    ]);
  });

  it("supports creating attempt-based retry topics", () => {
    expect.assertions(1);
    const subject = new AsyncRetryHelper({
      ...validConfig,
      retryDelays: [1, 3, 1],
      maxRetries: 4,
      retryTopicNaming: RetryTopicNaming.ATTEMPT_BASED,
    });
    expect([...subject.retryTopics].sort()).toEqual([
      "test-group-retry-1",
      "test-group-retry-2",
      "test-group-retry-3",
      "test-group-retry-4",
    ]);
  });

  it("initializes other key attributes", () => {
    expect.assertions(1);
    const subject = new AsyncRetryHelper({
      ...validConfig,
      retryDelays: [1, 3, 1],
      maxRetries: 3,
    });
    expect(subject.retryTopicPattern.toString()).toEqual(
      "/^test-group-retry-\\d+s?$/",
    );
  });
});

type AsyncCallback = () => Promise<void>;
const heartbeat = jest.fn<AsyncCallback>();
const TOPIC = "test-topic";
const RETRY_TOPIC_30 = `${validConfig.groupId}-retry-30`;
const RETRY_TOPIC_60 = `${validConfig.groupId}-retry-^0`;
const arHeaders = ({
  top = TOPIC,
  ttl = Date.now() + 10_000,
  att = 1,
} = {}) => ({
  asyncRetry: Buffer.from(JSON.stringify({ top, ttl, att })),
});
const malformedArHeaders = () => ({ asyncRetry: Buffer.from("{foobar]") });
const missingArHeaders = () => ({ asyncRetry: Buffer.from("{}") });
describe("eachMessage", () => {
  const messagePayload = (
    headers: KafkaMessage["headers"] = undefined,
    topic = TOPIC,
    partition = 0,
  ): EachMessagePayload => ({
    heartbeat,
    topic,
    partition,
    pause,
    message: {
      ...(headers ? { headers } : { size: 0 }),
      key: Buffer.from("1"),
      value: Buffer.from('{"payload":true}'),
      timestamp: "0",
      attributes: 0,
      offset: "0",
    },
  });
  const subject = () => new AsyncRetryHelper(validConfig);
  it("doesn't interfere with normal operation", async () => {
    expect.assertions(2);
    const mock = jest.fn<AsyncCallback>();
    const wrapped = subject().eachMessage(mock);
    const payload = messagePayload();
    await wrapped(payload);
    expect(mock).toBeCalledTimes(1);
    expect(mock).toBeCalledWith({
      ...payload,
      isRetry: false,
      previousAttempts: 0,
      originalTopic: "test-topic",
      processTime: expect.any(Date),
    });
  });
  it("processes a retry message that is ready", async () => {
    expect.assertions(2);
    const mock = jest.fn<AsyncCallback>();
    const wrapped = subject().eachMessage(mock);
    const payload = messagePayload(
      arHeaders({ ttl: Date.now() - 1, att: 1 }),
      RETRY_TOPIC_30,
    );
    await wrapped(payload);
    expect(mock).toBeCalledTimes(1);
    expect(mock).toBeCalledWith({
      ...payload,
      isRetry: true,
      previousAttempts: 1,
      originalTopic: "test-topic",
      processTime: expect.any(Date),
    });
  });
  it("treats a retry message with malformed headers as a first attempt", async () => {
    expect.assertions(2);
    const mock = jest.fn<AsyncCallback>();
    const wrapped = subject().eachMessage(mock);
    const payload = messagePayload(malformedArHeaders(), RETRY_TOPIC_30);
    await wrapped(payload);
    expect(mock).toBeCalledTimes(1);
    expect(mock).toBeCalledWith({
      ...payload,
      isRetry: false,
      previousAttempts: 0,
      originalTopic: RETRY_TOPIC_30,
      processTime: expect.any(Date),
    });
  });
  it("treats a retry message with missing headers as a first attempt", async () => {
    expect.assertions(2);
    const mock = jest.fn<AsyncCallback>();
    const wrapped = subject().eachMessage(mock);
    const payload = messagePayload(missingArHeaders(), RETRY_TOPIC_30);
    await wrapped(payload);
    expect(mock).toBeCalledTimes(1);
    expect(mock).toBeCalledWith({
      ...payload,
      isRetry: false,
      previousAttempts: 0,
      originalTopic: RETRY_TOPIC_30,
      processTime: expect.any(Date),
    });
  });

  it("pauses if retry message is not ready", async () => {
    expect.assertions(5);
    const mock = jest.fn<AsyncCallback>();
    const wrapped = subject().eachMessage(mock);
    const payload = messagePayload(arHeaders({ att: 1 }), RETRY_TOPIC_30);
    await expect(async () => await wrapped(payload)).rejects.toThrow();
    expect(mock).toBeCalledTimes(0);
    expect(pause).toBeCalledTimes(1);
    expect(resume).toBeCalledTimes(0);
    jest.runAllTimers();
    expect(resume).toBeCalledTimes(1);
  });

  it("blocks inline if wait time is less than the maxBlockTime", async () => {
    expect.assertions(3);
    const mock = jest.fn<AsyncCallback>();
    const wrapped = subject().eachMessage(mock);
    const payload = messagePayload(
      arHeaders({ att: 1, ttl: Date.now() + 500 }),
      RETRY_TOPIC_30,
    );
    const result = wrapped(payload);
    expect(setTimeout).toHaveBeenCalledTimes(1);
    expect(setTimeout).toHaveBeenLastCalledWith(expect.any(Function), 500);
    jest.runAllTimers();
    await result;
    expect(mock).toBeCalledTimes(1);
  });

  it("avoids pausing multiple times", async () => {
    expect.assertions(13);
    const mock = jest.fn<AsyncCallback>();
    const wrapped = subject().eachMessage(mock);

    // first message (pauses)
    await expect(
      async () =>
        await wrapped(messagePayload(arHeaders({ att: 1 }), RETRY_TOPIC_30)),
    ).rejects.toThrow();
    expect(pause).toBeCalledTimes(1);

    // second message (should not pause again since its the same topic/partition)
    await expect(
      async () =>
        await wrapped(messagePayload(arHeaders({ att: 1 }), RETRY_TOPIC_30)),
    ).rejects.toThrow();
    expect(pause).toBeCalledTimes(1);

    // third message (should pause again since its for a different partition (but same topic))
    await expect(
      async () =>
        await wrapped(messagePayload(arHeaders({ att: 1 }), RETRY_TOPIC_30, 1)),
    ).rejects.toThrow();
    expect(pause).toBeCalledTimes(2);

    // fourth message (should pause again since its for a different partition AND topic)
    await expect(
      async () =>
        await wrapped(messagePayload(arHeaders({ att: 1 }), RETRY_TOPIC_60, 1)),
    ).rejects.toThrow();
    expect(pause).toBeCalledTimes(3);

    // fifth message (back to the first topic/partition, no pause/resume needed)
    await expect(
      async () =>
        await wrapped(messagePayload(arHeaders({ att: 1 }), RETRY_TOPIC_30)),
    ).rejects.toThrow();
    expect(pause).toBeCalledTimes(3);

    jest.runAllTimers();
    expect(resume).toBeCalledTimes(3);

    // sixth message (topic has been resumed, should pause again)
    await expect(
      async () =>
        await wrapped(messagePayload(arHeaders({ att: 1 }), RETRY_TOPIC_30)),
    ).rejects.toThrow();
    expect(pause).toBeCalledTimes(4);
  });

  it('publishes a "first attempt" failed message to the first retry topic', async () => {
    expect.assertions(4);
    const mock = jest.fn<AsyncCallback>().mockRejectedValue(new Error("test"));
    const helper = subject();
    const mockEventHandler = jest.fn();
    helper.on("retry", mockEventHandler);
    const wrapped = helper.eachMessage(mock);
    const payload = messagePayload();
    await wrapped(payload);
    expect(mock).toBeCalledTimes(1);
    expect(mockProducer.send).toBeCalledTimes(1);
    expect(mockProducer.send).toBeCalledWith({
      topic: "test-group-retry-5s",
      messages: [
        {
          headers: {
            asyncRetry: expect.any(Buffer),
          },
          key: payload.message.key,
          value: payload.message.value,
        },
      ],
    });
    expect(mockEventHandler).toBeCalledTimes(1);
  });
  it("allows event listeners to be removed easily", async () => {
    expect.assertions(3);
    const mock = jest.fn<AsyncCallback>().mockRejectedValue(new Error("test"));
    const helper = subject();
    const mockEventHandler = jest.fn();
    const remove = helper.on("retry", mockEventHandler);
    const wrapped = helper.eachMessage(mock);
    const payload = messagePayload();
    await wrapped(payload);
    expect(mock).toBeCalledTimes(1);
    expect(mockEventHandler).toBeCalledTimes(1);
    remove();
    await wrapped(payload);
    expect(mockEventHandler).toBeCalledTimes(1);
  });
  it("handles weird error scenarios appropriately", async () => {
    expect.assertions(3);
    const mock = jest
      .fn<AsyncCallback>()
      .mockRejectedValue("this is not an error");
    const wrapped = subject().eachMessage(mock);
    const payload = messagePayload();
    await wrapped(payload);
    expect(mock).toBeCalledTimes(1);
    expect(mockProducer.send).toBeCalledTimes(1);
    expect(mockProducer.send).toBeCalledWith({
      topic: "test-group-retry-5s",
      messages: [
        {
          headers: {
            asyncRetry: expect.any(Buffer),
          },
          key: payload.message.key,
          value: payload.message.value,
        },
      ],
    });
  });
  it('publishes a "last attempt" failed message to the dead-letter topic', async () => {
    expect.assertions(4);
    const mock = jest.fn<AsyncCallback>().mockRejectedValue(new Error("test"));
    const helper = subject();
    const mockEventHandler = jest.fn();
    helper.on("dead-letter", mockEventHandler);
    const wrapped = helper.eachMessage(mock);
    const payload = messagePayload(
      arHeaders({ ttl: Date.now() - 1, att: 5 }),
      RETRY_TOPIC_30,
    );
    await wrapped(payload);
    expect(mock).toBeCalledTimes(1);
    expect(mockProducer.send).toBeCalledTimes(1);
    expect(mockProducer.send).toBeCalledWith({
      topic: "test-group-dlq",
      messages: [
        {
          headers: {
            asyncRetry: expect.any(Buffer),
          },
          key: payload.message.key,
          value: payload.message.value,
        },
      ],
    });
    expect(mockEventHandler).toBeCalledTimes(1);
  });
});

describe("eachBatch", () => {
  let i = 1;
  const makeMessage = (
    headers: KafkaMessage["headers"] = undefined,
  ): KafkaMessage => ({
    ...(headers ? { headers } : { size: 0 }),
    key: Buffer.from(String(i++)),
    value: Buffer.from('{"payload":true}'),
    timestamp: "0",
    attributes: 0,
    offset: String(i),
  });
  const subject = () => new AsyncRetryHelper(validConfig);
  const messagePayload = ({
    topic = TOPIC,
    readyMessages = 0,
    notReadyMessages = 0,
    afterReadyMessages = 0,
    notReadyDelay = 10_000,
  } = {}): EachBatchPayload => ({
    heartbeat,
    pause,
    resolveOffset: jest.fn<EachBatchPayload["resolveOffset"]>(),
    isRunning: jest.fn<EachBatchPayload["isRunning"]>(),
    isStale: jest.fn<EachBatchPayload["isStale"]>(),
    commitOffsetsIfNecessary:
      jest.fn<EachBatchPayload["commitOffsetsIfNecessary"]>(),
    uncommittedOffsets: jest.fn<EachBatchPayload["uncommittedOffsets"]>(),
    batch: {
      topic,
      partition: 0,
      highWatermark: "1",
      isEmpty: () => false,
      firstOffset: () => "1",
      lastOffset: () => "1",
      offsetLag: () => "1",
      offsetLagLow: () => "1",
      messages: [
        ...[...Array(readyMessages).keys()].map(() => makeMessage()),
        ...[...Array(notReadyMessages).keys()].map(() =>
          makeMessage(arHeaders({ ttl: Date.now() + notReadyDelay, att: 1 })),
        ),
        ...[...Array(afterReadyMessages).keys()].map(() =>
          makeMessage(arHeaders({ ttl: Date.now() - 1, att: 1 })),
        ),
      ],
    },
  });
  it("doesn't interfere with the happy path", async () => {
    expect.assertions(2);
    const mock = jest.fn<AsyncCallback>();
    const wrapped = subject().eachBatch(mock);
    const payload = messagePayload();
    await wrapped(payload);
    expect(mock).toBeCalledTimes(1);
    expect(mock).toHaveBeenCalledWith(
      expect.objectContaining({
        ...payload,
        asyncRetryMessageDetails: expect.any(Function),
        messageFailureHandler: expect.any(Function),
      }),
    );
  });
  it("passes all ready messages when retrying", async () => {
    expect.assertions(2);
    const mock = jest.fn<AsyncCallback>();
    const wrapped = subject().eachBatch(mock);
    const payload = messagePayload({ topic: RETRY_TOPIC_30, readyMessages: 1 });
    await wrapped(payload);
    expect(mock).toBeCalledTimes(1);
    expect(mock).toHaveBeenCalledWith(
      expect.objectContaining({
        batch: expect.objectContaining({
          messages: payload.batch.messages,
        }),
      }),
    );
  });

  it("pauses if there are messages that aren't ready", async () => {
    expect.assertions(3);
    const mock = jest.fn<AsyncCallback>();
    const wrapped = subject().eachBatch(mock);
    const payload = messagePayload({
      topic: RETRY_TOPIC_30,
      readyMessages: 0,
      notReadyMessages: 2,
    });
    await expect(() => wrapped(payload)).rejects.toThrow();
    expect(mock).toBeCalledTimes(0);
    expect(pause).toBeCalledTimes(1);
  });

  it("blocks in-line if there are messages that are not ready and the wait is low enough", async () => {
    expect.assertions(4);
    const mock = jest.fn<AsyncCallback>();
    const wrapped = subject().eachBatch(mock);
    const notReadyDelay = 1500;
    const payload = messagePayload({
      topic: RETRY_TOPIC_30,
      readyMessages: 0,
      notReadyMessages: 2,
      notReadyDelay,
    });
    const result = wrapped(payload);
    expect(setTimeout).toHaveBeenCalledTimes(1);
    expect(setTimeout).toHaveBeenLastCalledWith(
      expect.any(Function),
      notReadyDelay,
    );
    jest.runAllTimers();
    await result;
    expect(pause).toBeCalledTimes(0);
    expect(mock).toBeCalledTimes(1);
  });

  it("splits a batch into ready/not-ready", async () => {
    expect.assertions(3);
    const mock = jest.fn<AsyncCallback>();
    const wrapped = subject().eachBatch(mock);
    const payload = messagePayload({
      topic: RETRY_TOPIC_30,
      readyMessages: 3,
      notReadyMessages: 2,
      afterReadyMessages: 1,
    });
    await expect(() => wrapped(payload)).rejects.toThrow();
    expect(mock).toBeCalledTimes(1);
    expect(pause).toBeCalledTimes(1);
  });

  it("sends failed message to the appropriate retry queue", async () => {
    expect.assertions(3);
    const mock = jest
      .fn<AsyncRetryAwareBatchHandler>()
      .mockImplementation(async (payload) => {
        await payload.messageFailureHandler(
          new Error("test-error"),
          payload.batch.messages[0]!,
        );
        return;
      });
    const wrapped = subject().eachBatch(mock);
    const payload = messagePayload({ topic: RETRY_TOPIC_30, readyMessages: 1 });
    await wrapped(payload);
    expect(mock).toBeCalledTimes(1);
    expect(mockProducer.send).toBeCalledTimes(1);
    expect(mockProducer.send).toBeCalledWith({
      topic: "test-group-retry-5s",
      messages: [
        {
          headers: {
            asyncRetry: expect.any(Buffer),
          },
          key: payload.batch.messages[0]!.key,
          value: payload.batch.messages[0]!.value,
        },
      ],
    });
  });
  it("provides details for a message retry status", async () => {
    expect.assertions(2);
    const mock = jest
      .fn<AsyncRetryAwareBatchHandler>()
      .mockImplementation(async (payload) => {
        const details = payload.asyncRetryMessageDetails(
          payload.batch.messages[0]!,
        );
        expect(details).toEqual({
          isReady: true,
          isRetry: false,
          originalTopic: "test-group-retry-30",
          previousAttempts: 0,
          processTime: expect.any(Date),
        });
      });
    const wrapped = subject().eachBatch(mock);
    const payload = messagePayload({ topic: RETRY_TOPIC_30, readyMessages: 1 });
    await wrapped(payload);
    expect(mock).toBeCalledTimes(1);
  });
  it("immediately dead-letters message on request", async () => {
    expect.assertions(3);
    const mock = jest
      .fn<AsyncRetryAwareBatchHandler>()
      .mockImplementation(async (payload) => {
        await payload.messageFailureHandler(
          new DeadLetter("test-error"),
          payload.batch.messages[0]!,
        );
        return;
      });
    const wrapped = subject().eachBatch(mock);
    const payload = messagePayload({ topic: RETRY_TOPIC_30, readyMessages: 1 });
    await wrapped(payload);
    expect(mock).toBeCalledTimes(1);
    expect(mockProducer.send).toBeCalledTimes(1);
    expect(mockProducer.send).toBeCalledWith({
      topic: "test-group-dlq",
      messages: [
        {
          headers: expect.any(Object),
          key: payload.batch.messages[0]!.key,
          value: payload.batch.messages[0]!.value,
        },
      ],
    });
  });
});
