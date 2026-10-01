/** A constant pixel tolerance keeps snapping useful at any timeline zoom. */
export function snapTime(value: number, targets: number[], pixelsPerSecond: number, disabled = false): number {
  if (disabled || pixelsPerSecond <= 0) return value;
  const tolerance = Math.min(0.25, 6 / pixelsPerSecond);
  let nearest = value, distance = tolerance;
  for (const target of targets) if (Number.isFinite(target) && Math.abs(value - target) <= distance) { distance = Math.abs(value - target); nearest = target; }
  return nearest;
}
