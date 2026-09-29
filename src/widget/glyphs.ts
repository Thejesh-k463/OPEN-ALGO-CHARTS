/**
 * The objects panel's row grip, read from the chrome registry. Every other
 * picture the widget drew for itself here moved into the registry in 2.5.10
 * and is shown by its id; this file goes when the panel asks for `grip` by id.
 */
import { CHROME_ICONS } from 'openalgo-charts/draw';

export const GRIP_GLYPH = CHROME_ICONS.grip;
