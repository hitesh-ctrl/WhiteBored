export const CANVAS_WIDTH = 1600;
export const CANVAS_HEIGHT = 900;
export const MAX_POINTS_PER_STROKE = 5000;
export const MAX_POINTS_PER_BATCH = 200;
export const MAX_STROKES_PER_BOARD = 5000;
export const MAX_POINTS_PER_BOARD = 500_000;
export const MIN_WIDTH = 1;
export const MAX_WIDTH = 40;
export const MAX_NAME_LENGTH = 30;
export const MAX_MESSAGE_BYTES = 256 * 1024;
export const MAX_TEXT_LENGTH = 200;
export const MAX_CONNECTIONS_PER_IP = 30;
export const BOARD_CREATES_PER_MINUTE = 5;
/** Font size in canvas units for a text stroke, derived from its width setting. */
export const fontSizeFor = (width: number) => 8 + 2 * width;
