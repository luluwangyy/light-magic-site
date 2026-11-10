import assert from 'node:assert/strict';
import test from 'node:test';
import {createCameraRecognition, createSpeechRecognition} from '../try/recognition.mjs';

function stubGlobal(t, name, value) {
  const saved = Object.getOwnPropertyDescriptor(globalThis, name);
  Object.defineProperty(globalThis, name, {configurable: true, value});
  t.after(() => {
    if (saved) Object.defineProperty(globalThis, name, saved);
    else delete globalThis[name];
  });
}

function deviceStream() {
  const track = new EventTarget();
  track.stops = 0;
  track.stop = () => { track.stops++; };
  return {track, getTracks: () => [track], getVideoTracks: () => [track]};
}

function cameraFixture(t, getUserMedia, createRecognizer) {
  stubGlobal(t, 'navigator', {mediaDevices: {getUserMedia}});
  let frameId = 0;
  const frames = new Map();
  stubGlobal(t, 'requestAnimationFrame', callback => {
    frames.set(++frameId, callback);
    return frameId;
  });
  stubGlobal(t, 'cancelAnimationFrame', id => frames.delete(id));
  const video = {srcObject: null, readyState: 2, currentTime: 0, play: async () => {}};
  const gestures = [], statuses = [], errors = [];
  const camera = createCameraRecognition({video, createRecognizer,
    onGesture: gesture => gestures.push(gesture),
    onStatus: status => statuses.push(status),
    onError: error => errors.push(error),
  });
  function frame(time) {
    const [id, callback] = frames.entries().next().value;
    frames.delete(id);
    video.currentTime = time / 1000;
    callback(time);
  }
  return {camera, video, gestures, statuses, errors, frames, frame};
}

test('camera requires stable evidence, emits once, and re-arms after neutral or a new pose', async t => {
  const stream = deviceStream();
  let categoryName = 'Open_Palm', closed = 0;
  const mock = cameraFixture(t, async constraints => {
    assert.equal(constraints.audio, false);
    return stream;
  }, async () => ({
    recognizeForVideo: () => ({gestures: categoryName ? [[{categoryName, score: .95}]] : []}),
    close: () => { closed++; },
  }));
  assert.equal(await mock.camera.start(), true);
  assert.equal(mock.video.srcObject, stream);
  [0, 100, 200, 300].forEach(mock.frame);
  assert.deepEqual(mock.gestures, []);
  [400, 500, 600, 700, 800].forEach(mock.frame);
  assert.deepEqual(mock.gestures.map(event => event.gesture), ['open-palm']);
  categoryName = 'Closed_Fist';
  [900, 1000, 1500, 1600, 1700, 1800].forEach(mock.frame);
  assert.equal(mock.gestures.length, 1);
  [1900, 2000].forEach(mock.frame);
  assert.deepEqual(mock.gestures.map(event => event.gesture), ['open-palm', 'fist']);
  categoryName = '';
  [2100, 2200, 2300, 2400].forEach(mock.frame);
  categoryName = 'Closed_Fist';
  [2500, 2600, 2700, 2800, 2900].forEach(mock.frame);
  assert.deepEqual(mock.gestures.map(event => event.gesture), ['open-palm', 'fist', 'fist']);
  mock.camera.stop();
  mock.camera.stop();
  assert.equal(stream.track.stops, 1);
  assert.equal(closed, 1);
  assert.equal(mock.video.srcObject, null);
  assert.equal(mock.frames.size, 0);
  assert.equal(mock.statuses.at(-1), 'Camera stopped');
});

test('denied camera permission keeps manual fallback and avoids loading the model', async t => {
  const mock = cameraFixture(t, async () => { throw {name: 'NotAllowedError'}; },
    () => assert.fail('A denied camera must not load the model'));
  assert.equal(await mock.camera.start(), false);
  assert.match(mock.errors[0], /permission was denied/);
  assert.equal(mock.statuses.at(-1), 'Camera stopped');
});

test('a camera that arrives after stop releases its tracks immediately', async t => {
  const stream = deviceStream();
  let grant;
  const mock = cameraFixture(t, () => new Promise(resolve => { grant = resolve; }),
    () => assert.fail('A cancelled camera must not load the model'));
  const pending = mock.camera.start();
  mock.camera.stop();
  assert.equal(await pending, false);
  grant(stream);
  await Promise.resolve();
  assert.equal(stream.track.stops, 1);
  assert.equal(mock.video.srcObject, null);
  assert.deepEqual(mock.errors, []);
});

function speechFixture(t, {readiness = 'available', startError} = {}) {
  const instances = [], checks = [], installs = [];
  class Speech {
    static async available(options) { checks.push(options); return readiness; }
    static async install(options) { installs.push(options); readiness = 'available'; return true; }
    constructor() { instances.push(this); }
    get processLocally() { return this.local ?? false; }
    set processLocally(value) { this.local = value; }
    start() {
      assert.equal(this.processLocally, true);
      assert.equal(this.lang, 'en-US');
      assert.equal(this.interimResults, false);
      if (startError) this.onerror({error: startError});
      else this.onstart();
    }
    abort() { this.aborted = true; this.onend(); }
  }
  stubGlobal(t, 'SpeechRecognition', Speech);
  const texts = [], statuses = [], errors = [];
  const speech = createSpeechRecognition({onText: text => texts.push(text),
    onStatus: status => statuses.push(status), onError: error => errors.push(error)});
  return {speech, instances, checks, installs, texts, statuses, errors};
}

test('cloud-only browser API never starts a microphone', async t => {
  class CloudSpeech { start() { assert.fail('Cloud recognizer started'); } }
  stubGlobal(t, 'SpeechRecognition', CloudSpeech);
  const errors = [];
  const speech = createSpeechRecognition({onText: () => {}, onStatus: () => {}, onError: error => errors.push(error)});
  assert.equal(speech.available, false);
  assert.equal(await speech.start(), false);
  assert.match(errors[0], /typing the phrase/);
});

test('speech requests local processing, delivers final text once, and ignores a retired recognizer', async t => {
  const mock = speechFixture(t);
  assert.equal(await mock.speech.start(), true);
  assert.deepEqual(mock.checks, [{langs: ['en-US'], processLocally: true}]);
  const recognizer = mock.instances[0];
  const draft = {0: {transcript: 'let there'}, isFinal: false};
  const final = {0: {transcript: ' Let there be light '}, isFinal: true};
  recognizer.onresult({resultIndex: 0, results: [draft]});
  recognizer.onresult({resultIndex: 0, results: [final]});
  recognizer.onresult({resultIndex: 0, results: [final]});
  assert.deepEqual(mock.texts, ['Let there be light']);
  recognizer.onend();
  assert.equal(mock.statuses.at(-1), 'Microphone stopped');
  assert.equal(await mock.speech.start(), true);
  recognizer.onresult({resultIndex: 1, results: [final, final]});
  assert.deepEqual(mock.texts, ['Let there be light']);
  mock.speech.stop();
  assert.equal(mock.instances[1].aborted, true);
});

test('installing a browser language pack asks for a fresh microphone start', async t => {
  const mock = speechFixture(t, {readiness: 'downloadable'});
  assert.equal(await mock.speech.start(), false);
  assert.deepEqual(mock.installs, [{langs: ['en-US'], processLocally: true}]);
  assert.equal(mock.instances.length, 0);
  assert.match(mock.statuses.at(-1), /Start the microphone again/);
  assert.equal(await mock.speech.start(), true);
  mock.speech.stop();
});

test('speech permission denial returns false and closes the local session', async t => {
  const mock = speechFixture(t, {startError: 'not-allowed'});
  assert.equal(await mock.speech.start(), false);
  assert.equal(mock.instances[0].aborted, true);
  assert.match(mock.errors[0], /permission was denied/);
  assert.equal(mock.statuses.at(-1), 'Microphone stopped');
});
