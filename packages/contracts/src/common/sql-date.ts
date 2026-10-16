import {z} from 'zod';
/** PostgreSQL date-only writes, without timezone conversion or year-0 remapping. */
export const sqlCalendarDateSchema=z.iso.date().refine(value=>Number(value.slice(0,4))>=1,'Year must be 0001–9999.');
