import { Injectable } from '@nestjs/common';
import type { MessageEvent } from '@nestjs/common';
import { Observable, Subject } from 'rxjs';

interface ProgressEventData {
  message: string;
  stage?: string;
  timestamp: string;
}

@Injectable()
export class ProgressService {
  private channels = new Map<string, Subject<MessageEvent>>();

  stream(id: string): Observable<MessageEvent> {
    let subject = this.channels.get(id);
    if (!subject) {
      subject = new Subject<MessageEvent>();
      this.channels.set(id, subject);
    }
    return subject.asObservable();
  }

  publish(id: string | undefined, message: string, stage?: string): void {
    if (!id) return;
    let subject = this.channels.get(id);
    if (!subject) {
      subject = new Subject<MessageEvent>();
      this.channels.set(id, subject);
    }
    const evt: ProgressEventData = {
      message,
      stage,
      timestamp: new Date().toISOString()
    };
    subject.next({ data: evt, type: 'progress' });
  }

  complete(id: string | undefined): void {
    if (!id) return;
    const subject = this.channels.get(id);
    if (subject) {
      subject.next({ data: { message: 'done', timestamp: new Date().toISOString() }, type: 'done' });
      subject.complete();
      this.channels.delete(id);
    }
  }
}

