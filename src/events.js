import { EventEmitter } from 'node:events';

export const appEvents = new EventEmitter();
appEvents.setMaxListeners(20);

export function emitNewsPublished(events, id) {
  events.emit('news.published', { id: Number(id) });
}
