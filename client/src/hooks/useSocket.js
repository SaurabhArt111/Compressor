import { useEffect, useRef } from 'react';
import { io } from 'socket.io-client';

let sharedSocket = null;
function getSocket() {
  if (!sharedSocket) {
    // Same-origin; in dev this is proxied to the backend by vite.config.js.
    sharedSocket = io({ transports: ['websocket', 'polling'] });
  }
  return sharedSocket;
}

/**
 * Joins the room for `jobId` and wires up the given event handlers for the
 * lifetime of the component / while jobId is set. Handlers object is read
 * fresh on every render via a ref so callers don't need to memoize them.
 */
export function useJobSocket(jobId, handlers) {
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  useEffect(() => {
    if (!jobId) return undefined;
    const socket = getSocket();
    const joinRoom = () => socket.emit('join-job', jobId);
    joinRoom();
    socket.on('connect', joinRoom);

    const events = ['file:start', 'file:progress', 'file:done', 'file:error', 'file:cancelled', 'job:start', 'job:done', 'job:cancelling'];
    const listeners = {};
    for (const evt of events) {
      const key = evt.replace(':', '_');
      listeners[evt] = (payload) => handlersRef.current?.[key]?.(payload);
      socket.on(evt, listeners[evt]);
    }

    return () => {
      for (const evt of events) socket.off(evt, listeners[evt]);
      socket.off('connect', joinRoom);
      socket.emit('leave-job', jobId);
    };
  }, [jobId]);
}
