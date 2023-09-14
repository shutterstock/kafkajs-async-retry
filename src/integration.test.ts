import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "@jest/globals";
import {
  Admin,
  Consumer,
  EachMessagePayload,
  Kafka,
  logLevel,
  Message,
  Partitioners,
  Producer,
} from "kafkajs";
import AsyncRetryHelper, { DeadLetter } from ".";

const maybe = process.env["INTEGRATION_KAFKA_BROKER"]
  ? describe
  : describe.skip;

interface TestMessage {
  failAttempts: number;
  instantDeadLetter?: boolean;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

maybe("Integration", () => {
  let kafka: Kafka;
  beforeAll(() => {
    kafka = new Kafka({
      logLevel: logLevel.WARN,
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      brokers: process.env["INTEGRATION_KAFKA_BROKER"]!.split(","),
    });
  });

  function createMessage(value: Partial<TestMessage> = {}): Message {
    const id = Date.now() % 10_000;
    return {
      key: String(id),
      value: JSON.stringify({ failAttempts: 0, ...value }),
    };
  }

  let numMessages = 0;
  let receivedMessages: {
    [topic: string]: string[];
  };

  async function recordMessage({
    topic,
    message,
  }: EachMessagePayload): Promise<void> {
    receivedMessages[topic] = receivedMessages[topic] || [];
    receivedMessages[topic].push(String(message.key));
    numMessages++;
  }

  beforeEach(() => {
    numMessages = 0;
    receivedMessages = {};
  });

  function waitForMessagesReceived(num: number): Promise<number> {
    const finalCount = numMessages + num;
    return new Promise((resolve) => {
      setInterval(() => {
        if (numMessages >= finalCount) resolve(finalCount);
      }, 50).unref();
    });
  }

  const RUN_ID = Date.now() % 1000;

  describe("attempt-based retry topics", () => {
    let subject: AsyncRetryHelper;

    let testConsumer: Consumer;
    let admin: Admin;
    let producer: Producer;
    let consumer: Consumer;

    const TEST_GROUP = `test-group-${RUN_ID}`;
    const TEST_TOPIC = `test-topic-${RUN_ID}`;
    beforeAll(async () => {
      admin = kafka.admin();
      producer = kafka.producer({
        createPartitioner: Partitioners.DefaultPartitioner,
      });
      consumer = kafka.consumer({ groupId: TEST_GROUP, maxWaitTimeInMs: 100 });
      subject = new AsyncRetryHelper({
        groupId: TEST_GROUP,
        producer,
        retryDelays: [1, 2, 3, 5],
        maxWaitTime: Infinity,
        maxRetries: 4,
      });

      // create topics
      await admin.connect();
      await admin.createTopics({
        validateOnly: false,
        topics: [
          TEST_TOPIC,
          ...subject.retryTopics,
          subject.deadLetterTopic,
        ].map((topic) => ({ topic })),
      });

      testConsumer = kafka.consumer({
        groupId: "test-validator",
        maxWaitTimeInMs: 100,
      });
      await Promise.all(
        [consumer, producer, testConsumer].map((c) => c.connect()),
      );

      await consumer.subscribe({
        topics: [TEST_TOPIC, ...subject.retryTopics],
      });
      // testConsumer wants to see the dead letter topic
      await testConsumer.subscribe({
        topics: [TEST_TOPIC, ...subject.retryTopics, subject.deadLetterTopic],
      });

      await Promise.all([
        testConsumer.run({ eachMessage: recordMessage }),
        consumer.run({
          partitionsConsumedConcurrently: 100,
          eachMessage: subject.eachMessage(async (payload) => {
            const data: TestMessage = JSON.parse(
              String(payload.message.value || "{}"),
            );
            if (data.instantDeadLetter) {
              throw new DeadLetter("Instant dead letter");
            }
            if (
              data.failAttempts &&
              data.failAttempts > payload.previousAttempts
            ) {
              throw new Error("Failed attempt");
            }
          }),
        }),
      ]);
      await sleep(10_000);
    }, 60_000);

    afterAll(async () => {
      await Promise.all(
        [admin, consumer, producer, testConsumer].map((c) => c.disconnect()),
      );
    });

    it("handles happy-path correctly", async () => {
      const done = waitForMessagesReceived(1);
      const message = createMessage();
      await producer.send({
        topic: TEST_TOPIC,
        messages: [message],
      });

      await done;

      expect(numMessages).toBe(1);
      expect(receivedMessages[TEST_TOPIC]).toHaveLength(1);
      expect(receivedMessages[TEST_TOPIC]).toContain(message.key);
    });

    it("sends to dead-letter immediately if needed", async () => {
      const done = waitForMessagesReceived(2);
      const message = createMessage({ instantDeadLetter: true });
      await producer.send({
        topic: TEST_TOPIC,
        messages: [message],
      });

      await done;

      expect(receivedMessages[TEST_TOPIC]).toHaveLength(1);
      expect(receivedMessages[TEST_TOPIC]).toContain(message.key);

      expect(receivedMessages[subject.deadLetterTopic]).toHaveLength(1);
      expect(receivedMessages[subject.deadLetterTopic]).toContain(message.key);
    });

    it("can succeed after single retry", async () => {
      const done = waitForMessagesReceived(2);
      const message = createMessage({ failAttempts: 1 });
      await producer.send({
        topic: TEST_TOPIC,
        messages: [message],
      });

      await done;

      expect(receivedMessages[TEST_TOPIC]).toHaveLength(1);
      expect(receivedMessages[TEST_TOPIC]).toContain(message.key);

      expect(receivedMessages[subject.retryTopics[0]]).toHaveLength(1);
      expect(receivedMessages[subject.retryTopics[0]]).toContain(message.key);
    });

    it("can succeed after several retres", async () => {
      const done = waitForMessagesReceived(4);
      const message = createMessage({ failAttempts: 3 });
      await producer.send({
        topic: TEST_TOPIC,
        messages: [message],
      });

      await done;

      expect(receivedMessages[TEST_TOPIC]).toHaveLength(1);
      expect(receivedMessages[TEST_TOPIC]).toContain(message.key);

      [0, 1, 2].forEach((i) => {
        expect(receivedMessages[subject.retryTopics[i]]).toHaveLength(1);
        expect(receivedMessages[subject.retryTopics[i]]).toContain(message.key);
      });
      expect(receivedMessages[subject.deadLetterTopic] || []).toHaveLength(0);
    }, 10_000);

    it("can dead-letter after several retres", async () => {
      const done = waitForMessagesReceived(6);
      const message = createMessage({ failAttempts: 5 });
      await producer.send({
        topic: TEST_TOPIC,
        messages: [message],
      });

      await done;

      expect(receivedMessages[TEST_TOPIC]).toHaveLength(1);
      expect(receivedMessages[TEST_TOPIC]).toContain(message.key);

      [0, 1, 2, 3].forEach((i) => {
        expect(receivedMessages[subject.retryTopics[i]]).toHaveLength(1);
        expect(receivedMessages[subject.retryTopics[i]]).toContain(message.key);
      });

      expect(receivedMessages[subject.deadLetterTopic] || []).toHaveLength(1);
      expect(receivedMessages[subject.deadLetterTopic]).toContain(message.key);
    }, 20_000);
  });
});
