// Two-hand spacing, not elbow/shoulder pose estimation. Separate opening and
// closing thresholds prevent a held open pose from flickering into a new cue.
export function armsState(previous, distance, close, far) {
  if (distance === null || close === null || far === null || far <= close) return false;
  const normalized = (distance - close) / (far - close);
  return previous ? normalized > .35 : normalized >= .8;
}
