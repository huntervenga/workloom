/** Shared pixel geometry for single-date diamonds and the arrows attached to their bounds. */
const POINT_SIZE = 16;
const POINT_ROTATION = 45;
const radians = POINT_ROTATION * Math.PI / 180;
/** Horizontal half-width of the rotated square, rather than half of its unrotated CSS width. */
export const POINT_RADIUS = POINT_SIZE / 2 * (Math.abs(Math.cos(radians)) + Math.abs(Math.sin(radians)));
export const pointStyle = {
  width: POINT_SIZE,
  height: POINT_SIZE,
  translate: '-50%',
  rotate: `${POINT_ROTATION}deg`,
} as const;
