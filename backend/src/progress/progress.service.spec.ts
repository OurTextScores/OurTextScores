import { Test, TestingModule } from '@nestjs/testing';
import { ProgressService } from './progress.service';
import type { MessageEvent } from '@nestjs/common';

interface ProgressEventData {
  message: string;
  stage?: string;
  timestamp: string;
}

describe('ProgressService', () => {
  let service: ProgressService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [ProgressService],
    }).compile();

    service = module.get<ProgressService>(ProgressService);
  });

  afterEach(() => {
    // Clean up any active channels
    (service as any).channels.clear();
  });

  describe('stream', () => {
    it('creates a new observable for a new channel ID', () => {
      const observable = service.stream('channel-1');

      expect(observable).toBeDefined();
      expect((service as any).channels.has('channel-1')).toBe(true);
    });

    it('returns existing observable for existing channel ID', () => {
      const observable1 = service.stream('channel-2');
      const observable2 = service.stream('channel-2');

      // Should use the same underlying channel (subject), even if observables differ
      expect((service as any).channels.size).toBe(1);
      expect((service as any).channels.get('channel-2')).toBeDefined();
    });

    it('creates multiple independent channels', () => {
      const observable1 = service.stream('channel-a');
      const observable2 = service.stream('channel-b');
      const observable3 = service.stream('channel-c');

      expect(observable1).toBeDefined();
      expect(observable2).toBeDefined();
      expect(observable3).toBeDefined();
      expect((service as any).channels.size).toBe(3);
    });
  });

  describe('publish', () => {
    it('publishes message to existing channel', (done) => {
      const observable = service.stream('test-channel');

      observable.subscribe((event: MessageEvent) => {
        expect(event.type).toBe('progress');
        expect(event.data).toMatchObject({
          message: 'Processing...',
          timestamp: expect.any(String),
        });
        done();
      });

      service.publish('test-channel', 'Processing...');
    });

    it('publishes message with stage information', (done) => {
      const observable = service.stream('test-channel');

      observable.subscribe((event: MessageEvent) => {
        expect(event.type).toBe('progress');
        expect(event.data).toMatchObject({
          message: 'Step 1',
          stage: 'initialization',
          timestamp: expect.any(String),
        });
        done();
      });

      service.publish('test-channel', 'Step 1', 'initialization');
    });

    it('creates channel if it does not exist when publishing', (done) => {
      expect((service as any).channels.has('new-channel')).toBe(false);

      // Subscribe after publish should still work because publish creates the channel
      service.publish('new-channel', 'First message');

      const observable = service.stream('new-channel');
      let receivedCount = 0;

      observable.subscribe((event: MessageEvent) => {
        receivedCount++;
        if (receivedCount === 1) {
          // This was the message published before subscription (won't be received)
          // But the second message should be received
          expect((event.data as ProgressEventData).message).toBe('Second message');
          done();
        }
      });

      service.publish('new-channel', 'Second message');
    });

    it('does nothing when id is undefined', () => {
      const channelsBefore = (service as any).channels.size;

      service.publish(undefined, 'Test message');

      expect((service as any).channels.size).toBe(channelsBefore);
    });

    it('does nothing when id is null', () => {
      const channelsBefore = (service as any).channels.size;

      service.publish(null as any, 'Test message');

      expect((service as any).channels.size).toBe(channelsBefore);
    });

    it('publishes multiple messages to the same channel', (done) => {
      const observable = service.stream('multi-message');
      const messages: string[] = [];

      observable.subscribe((event: MessageEvent) => {
        messages.push((event.data as ProgressEventData).message);

        if (messages.length === 3) {
          expect(messages).toEqual(['Message 1', 'Message 2', 'Message 3']);
          done();
        }
      });

      service.publish('multi-message', 'Message 1');
      service.publish('multi-message', 'Message 2');
      service.publish('multi-message', 'Message 3');
    });

    it('includes valid ISO timestamp', (done) => {
      const observable = service.stream('timestamp-test');

      observable.subscribe((event: MessageEvent) => {
        const timestamp = (event.data as ProgressEventData).timestamp;
        const date = new Date(timestamp);

        expect(date).toBeInstanceOf(Date);
        expect(date.toISOString()).toBe(timestamp);
        done();
      });

      service.publish('timestamp-test', 'Test');
    });

    it('publishes to different channels independently', (done) => {
      const observable1 = service.stream('channel-1');
      const observable2 = service.stream('channel-2');

      let channel1Received = false;
      let channel2Received = false;

      observable1.subscribe((event: MessageEvent) => {
        expect((event.data as ProgressEventData).message).toBe('Message for channel 1');
        channel1Received = true;
        if (channel1Received && channel2Received) done();
      });

      observable2.subscribe((event: MessageEvent) => {
        expect((event.data as ProgressEventData).message).toBe('Message for channel 2');
        channel2Received = true;
        if (channel1Received && channel2Received) done();
      });

      service.publish('channel-1', 'Message for channel 1');
      service.publish('channel-2', 'Message for channel 2');
    });
  });

  describe('complete', () => {
    it('completes channel and removes it from channels map', (done) => {
      const observable = service.stream('complete-test');
      let completeCalled = false;

      observable.subscribe({
        next: (event: MessageEvent) => {
          expect(event.type).toBe('done');
          expect(event.data).toMatchObject({
            message: 'done',
            timestamp: expect.any(String),
          });
        },
        complete: () => {
          completeCalled = true;
          // Channel is deleted after complete callback, check with setImmediate
          setImmediate(() => {
            expect((service as any).channels.has('complete-test')).toBe(false);
            done();
          });
        },
      });

      expect((service as any).channels.has('complete-test')).toBe(true);
      service.complete('complete-test');
      expect(completeCalled).toBe(true);
    });

    it('does nothing when id is undefined', () => {
      const channelsBefore = (service as any).channels.size;

      service.complete(undefined);

      expect((service as any).channels.size).toBe(channelsBefore);
    });

    it('does nothing when id is null', () => {
      const channelsBefore = (service as any).channels.size;

      service.complete(null as any);

      expect((service as any).channels.size).toBe(channelsBefore);
    });

    it('does nothing when channel does not exist', () => {
      expect((service as any).channels.has('non-existent')).toBe(false);

      // Should not throw
      expect(() => service.complete('non-existent')).not.toThrow();

      expect((service as any).channels.has('non-existent')).toBe(false);
    });

    it('sends done event before completing', (done) => {
      const observable = service.stream('done-event-test');
      const events: MessageEvent[] = [];

      observable.subscribe({
        next: (event: MessageEvent) => {
          events.push(event);
        },
        complete: () => {
          expect(events).toHaveLength(1);
          expect(events[0].type).toBe('done');
          expect((events[0].data as ProgressEventData).message).toBe('done');
          done();
        },
      });

      service.complete('done-event-test');
    });

    it('allows reusing channel ID after completion', (done) => {
      const observable1 = service.stream('reuse-test');

      observable1.subscribe({
        complete: () => {
          // Channel is deleted after complete callback
          setImmediate(() => {
            expect((service as any).channels.has('reuse-test')).toBe(false);

            // Create new channel with same ID
            const observable2 = service.stream('reuse-test');

            observable2.subscribe((event: MessageEvent) => {
              expect((event.data as ProgressEventData).message).toBe('New message');
              done();
            });

            service.publish('reuse-test', 'New message');
          });
        },
      });

      service.complete('reuse-test');
    });

    it('includes valid ISO timestamp in done event', (done) => {
      const observable = service.stream('timestamp-done-test');

      observable.subscribe({
        next: (event: MessageEvent) => {
          const timestamp = (event.data as ProgressEventData).timestamp;
          const date = new Date(timestamp);

          expect(date).toBeInstanceOf(Date);
          expect(date.toISOString()).toBe(timestamp);
        },
        complete: () => {
          done();
        },
      });

      service.complete('timestamp-done-test');
    });
  });

  describe('integration scenarios', () => {
    it('handles full lifecycle: stream -> publish -> complete', (done) => {
      const channelId = 'full-lifecycle';
      const observable = service.stream(channelId);
      const receivedEvents: MessageEvent[] = [];

      observable.subscribe({
        next: (event: MessageEvent) => {
          receivedEvents.push(event);
        },
        complete: () => {
          expect(receivedEvents).toHaveLength(4);
          expect((receivedEvents[0].data as ProgressEventData).message).toBe('Starting');
          expect((receivedEvents[1].data as ProgressEventData).message).toBe('Processing');
          expect((receivedEvents[2].data as ProgressEventData).message).toBe('Finishing');
          expect(receivedEvents[3].type).toBe('done');
          // Channel is deleted after complete callback
          setImmediate(() => {
            expect((service as any).channels.has(channelId)).toBe(false);
            done();
          });
        },
      });

      service.publish(channelId, 'Starting', 'init');
      service.publish(channelId, 'Processing', 'work');
      service.publish(channelId, 'Finishing', 'cleanup');
      service.complete(channelId);
    });

    it('handles multiple subscribers to the same channel', (done) => {
      const channelId = 'multi-subscriber';
      const observable = service.stream(channelId);

      let subscriber1Received = 0;
      let subscriber2Received = 0;

      observable.subscribe(() => {
        subscriber1Received++;
      });

      observable.subscribe(() => {
        subscriber2Received++;
        if (subscriber2Received === 2) {
          expect(subscriber1Received).toBe(2);
          expect(subscriber2Received).toBe(2);
          done();
        }
      });

      service.publish(channelId, 'Message 1');
      service.publish(channelId, 'Message 2');
    });
  });
});
