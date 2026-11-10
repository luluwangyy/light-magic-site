// The upstream MediaPipe files and their hashes are listed in vendor/manifest.json.
const WASM_PATH = new URL('./vendor/wasm', import.meta.url).href;
const HAND_MODEL = 'https://storage.googleapis.com/mediapipe-models/gesture_recognizer/gesture_recognizer/float16/1/gesture_recognizer.task';
const GESTURES = {Open_Palm:'open-palm', Closed_Fist:'fist'};

async function loadHandRecognizer() {
  const {FilesetResolver, GestureRecognizer} = await import('./vendor/vision_bundle.mjs');
  const files = await FilesetResolver.forVisionTasks(WASM_PATH);
  return GestureRecognizer.createFromOptions(files, {
    baseOptions: {modelAssetPath: HAND_MODEL, delegate: 'CPU'},
    runningMode: 'VIDEO',
    numHands: 1,
  });
}

function stableGesture() {
  let candidate, since, previousSample, latched, neutralSince;
  return (category, now) => {
    if (now - previousSample > 240) {
      candidate = undefined;
      neutralSince = undefined;
    }
    previousSample = now;
    const gesture = Object.hasOwn(GESTURES, category?.categoryName) && GESTURES[category.categoryName];
    if (!gesture || !(category.score >= .70 && category.score <= 1)) {
      candidate = undefined;
      neutralSince ??= now;
      if (now - neutralSince >= 250) latched = undefined;
      return;
    }
    neutralSince = undefined;
    if (gesture !== candidate) {
      candidate = gesture;
      since = now;
    }
    if (gesture === latched || now - since < 320) return;
    latched = gesture;
    return {gesture, score: category.score};
  };
}

function stopTracks(stream) {
  for (const track of stream?.getTracks() ?? []) track.stop();
}

export function createCameraRecognition({
  video, onGesture, onLandmarks = () => {}, onStatus, onError, createRecognizer = loadHandRecognizer,
}) {
  let session;

  function stop() {
    const current = session;
    if (!current) return;
    session = undefined;
    current.cancel(false);
    if (current.frame !== undefined) cancelAnimationFrame(current.frame);
    stopTracks(current.stream);
    if (current.stream && video.srcObject === current.stream) video.srcObject = null;
    try { current.recognizer?.close(); } catch { /* The media stream has already been released. */ }
    onLandmarks([]);
    onStatus('Camera stopped');
  }

  function fail(current, message) {
    if (session === current) {
      stop();
      onError(message);
    }
    return false;
  }

  async function open(current) {
    const media = globalThis.navigator?.mediaDevices;
    if (typeof media?.getUserMedia !== 'function') {
      return fail(current, 'Camera access is unavailable. Try the manual gesture buttons.');
    }
    onStatus('Waiting for camera access');
    try {
      const stream = await media.getUserMedia({audio: false, video: {
        facingMode: 'user', width: {ideal: 640}, height: {ideal: 480},
      }});
      if (session !== current) {
        stopTracks(stream);
        return false;
      }
      current.stream = stream;
      for (const track of stream.getVideoTracks()) {
        track.addEventListener('ended', () => fail(current, 'Camera disconnected. Start it again or use a manual gesture.'), {once: true});
      }
      video.muted = true;
      video.playsInline = true;
      video.srcObject = stream;
      await video.play();
      if (session !== current) return false;
      onStatus('Loading hand recognition');
      const recognizer = await createRecognizer();
      if (session !== current) {
        recognizer.close();
        return false;
      }
      current.recognizer = recognizer;
      const observe = stableGesture();
      let lastFrame = -1, lastSample = -Infinity;
      function frame(now) {
        if (session !== current) return;
        if (video.readyState >= 2 && video.currentTime !== lastFrame && now - lastSample >= 80) {
          lastFrame = video.currentTime;
          lastSample = now;
          try {
            const result = recognizer.recognizeForVideo(video, now);
            onLandmarks(result.landmarks?.[0] ?? []);
            const gesture = observe(result.gestures?.[0]?.[0], now);
            if (gesture) onGesture(gesture);
          } catch {
            fail(current, 'Camera recognition stopped. Try restarting it or use a manual gesture.');
          }
        }
        if (session === current) current.frame = requestAnimationFrame(frame);
      }
      current.frame = requestAnimationFrame(frame);
      onStatus('Camera ready');
      return session === current;
    } catch (error) {
      const messages = {
        NotAllowedError: 'Camera permission was denied. Allow it in your browser or use a manual gesture.',
        NotFoundError: 'No camera was found. Connect a camera or use a manual gesture.',
        NotReadableError: 'The camera could not open. Close any other app using it or use a manual gesture.',
      };
      return fail(current, messages[error?.name] || 'Could not start camera recognition. Check your camera and connection, or use a manual gesture.');
    }
  }

  function start() {
    if (session) return session.ready;
    const current = {};
    const cancelled = new Promise(resolve => { current.cancel = resolve; });
    session = current;
    current.ready = Promise.race([cancelled, open(current)]);
    return current.ready;
  }

  return {start, stop};
}

export function createSpeechRecognition({onText, onStatus, onError}) {
  const Recognition = globalThis.SpeechRecognition ?? globalThis.webkitSpeechRecognition;
  const available = !!(Recognition?.prototype && 'processLocally' in Recognition.prototype &&
                       typeof Recognition.available === 'function');
  const lang = 'en-US';
  let session;

  function finish(current, status = 'Microphone stopped', abort = false) {
    if (session !== current) return;
    session = undefined;
    current.resolve(false);
    if (abort) {
      try { current.recognition?.abort(); } catch { /* The browser may already have ended. */ }
    }
    onStatus(status);
  }

  function stop() {
    if (session) finish(session, 'Microphone stopped', true);
  }

  function fail(current, message) {
    if (session !== current) return;
    stop();
    onError(message);
  }

  async function open(current) {
    onStatus('Checking on-device English speech');
    try {
      const options = {langs: [lang], processLocally: true};
      const readiness = await Recognition.available(options);
      if (session !== current) return;
      if (readiness !== 'available') {
        if (!['downloadable', 'downloading'].includes(readiness) || typeof Recognition.install !== 'function') {
          fail(current, 'On-device English speech is unavailable. Try typing the phrase.');
          return;
        }
        onStatus('Installing the browser’s on-device English pack');
        if (await Recognition.install(options)) {
          finish(current, 'English pack ready. Start the microphone again.');
        } else {
          fail(current, 'The local English pack could not install. Try typing the phrase.');
        }
        return;
      }
      const recognition = new Recognition();
      current.recognition = recognition;
      recognition.lang = lang;
      recognition.continuous = true;
      recognition.interimResults = false;
      recognition.processLocally = true;
      if (recognition.processLocally !== true) {
        fail(current, 'This browser cannot keep speech on-device. Try typing the phrase.');
        return;
      }
      recognition.onstart = () => {
        if (session !== current) return;
        onStatus('Listening on this device');
        current.resolve(true);
      };
      recognition.onresult = event => {
        for (let index = Math.max(event.resultIndex ?? 0, current.nextFinal);
             session === current && index < event.results.length; index++) {
          const result = event.results[index];
          if (!result.isFinal) continue;
          current.nextFinal = index + 1;
          const text = result[0]?.transcript?.trim();
          if (text) onText(text);
        }
      };
      recognition.onend = () => finish(current);
      recognition.onerror = event => {
        const messages = {
          'not-allowed': 'Microphone permission was denied. Allow it in your browser or type the phrase.',
          'audio-capture': 'No microphone was available. Connect one or type the phrase.',
          'no-speech': 'No speech was heard. Start the microphone again or type the phrase.',
        };
        fail(current, messages[event.error] || 'On-device recognition ended. Start it again or type the phrase.');
      };
      onStatus('Waiting for microphone access');
      recognition.start();
    } catch {
      fail(current, 'On-device speech could not start. Try typing the phrase.');
    }
  }

  function start() {
    if (!available) {
      onError('This browser does not offer on-device speech recognition. Try typing the phrase.');
      return Promise.resolve(false);
    }
    if (session) return session.ready;
    const current = {nextFinal: 0};
    current.ready = new Promise(resolve => { current.resolve = resolve; });
    session = current;
    void open(current);
    return current.ready;
  }

  return {available, start, stop};
}
