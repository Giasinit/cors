// Monotonic client observations, not timings inside the upstream gateway/backend.
export function requestDiagnostics(notify) {
  const started = performance.now();
  const milestones = {};
  let phase = 'socket', phaseStarted = started;
  let bytesReceived = 0, upstreamStatus, reusedSocket = false;
  let outcome = 'pending', causeCode, timeoutKind;
  const rounded = value => Math.round(value * 10) / 10;
  const difference = (end, begin) => milestones[end] !== undefined && milestones[begin] !== undefined
    ? rounded(milestones[end] - milestones[begin]) : null;
  const snapshot = () => ({
    elapsedMs: rounded(performance.now() - started), phase,
    phaseElapsedMs: rounded(performance.now() - phaseStarted), outcome,
    milestonesMs: { ...milestones },
    durationsMs: {
      socketWait: milestones.socket ?? null,
      dns: difference('dns', 'socket'),
      tcp: difference('tcp', milestones.dns !== undefined ? 'dns' : 'socket'),
      tls: difference('tls', 'tcp'),
      requestSend: difference('requestSent', 'tls'),
      responseWait: difference('responseHeaders', 'requestSent'),
      download: difference('bodyEnd', 'responseHeaders'),
    },
    bytesReceived, reusedSocket,
    ...(upstreamStatus !== undefined ? { upstreamStatus } : {}),
    ...(causeCode ? { causeCode } : {}), ...(timeoutKind ? { timeoutKind } : {}),
  });
  const publish = () => notify?.(snapshot());
  const mark = (name, nextPhase) => {
    if (outcome !== 'pending') return;
    milestones[name] ??= rounded(performance.now() - started);
    if (nextPhase && phase !== nextPhase) { phase = nextPhase; phaseStarted = performance.now(); }
    publish();
  };
  return {
    snapshot,
    start: publish,
    socket(socket, needsDns) {
      if (!socket.connecting) {
        reusedSocket = true;
        mark('socket', 'request_send');
        return;
      }
      mark('socket', needsDns ? 'dns' : 'tcp');
      socket.once('lookup', error => { if (!error) mark('dns', 'tcp'); });
      socket.once('connect', () => mark('tcp', 'tls'));
      socket.once('secureConnect', () => mark('tls', 'request_send'));
    },
    sent: () => mark('requestSent', 'response_headers'),
    response(status) { upstreamStatus = status; mark('responseHeaders', 'response_body'); },
    data(chunk) {
      if (outcome !== 'pending') return;
      bytesReceived += chunk.length;
      if (milestones.firstBody === undefined) mark('firstBody');
    },
    end: () => mark('bodyEnd'),
    finish(error, kind) {
      if (outcome !== 'pending') return snapshot();
      outcome = error ? (kind ? 'timeout' : error.code === 'CLIENT_ABORTED' ? 'aborted' : 'error') : 'success';
      causeCode = error?.code;
      timeoutKind = kind;
      if (!error) { phase = 'complete'; phaseStarted = performance.now(); }
      publish();
      return snapshot();
    },
  };
}
