import { useEffect, useRef } from 'react';
import { io } from 'socket.io-client';

let sharedSocket = null;
function getSocket() {
  if (!sharedSocket) {
    // No explicit transports override: this lets socket.io use its own
    // well-tested default negotiation (start on HTTP long-polling, then
    // upgrade to a WebSocket once one is confirmed to work end-to-end).
    // Forcing "websocket" first is more brittle behind proxies/dev-server
    // upgrade handling and surfaces a raw failed-WebSocket console error
    // even when the underlying connection is actually fine and about to
    // fall back successfully - polling-first avoids that noise entirely.
    sharedSocket = io();
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
    // Every 'connect' firing after the very first one means the socket had
    // dropped and just came back (a flaky network, a proxy hiccup, a dev
    // server restart, ...). Progress events emitted while disconnected are
    // simply lost, so on any reconnect we re-fetch the job's current state
    // from the server (the source of truth - compression keeps running
    // there regardless of any client's connection) rather than leaving the
    // UI looking frozen or silently out of date.
    const resync = () => handlersRef.current?.resync?.();
    joinRoom();
    socket.on('connect', joinRoom);
    socket.on('connect', resync);

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
      socket.off('connect', resync);
      socket.emit('leave-job', jobId);
    };
  }, [jobId]);
}
