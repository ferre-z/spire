import { z } from "zod";
import {
  controlOperationNameSchema,
  type ControlOperationName,
} from "./control";

export const COORDINATOR_PROTOCOL_VERSION = 1;

export type ControlRequest = Readonly<{
  operation: ControlOperationName;
  input: unknown;
}>;

export const controlRequestSchema = z.strictObject({
  operation: controlOperationNameSchema,
  input: z.unknown(),
}) satisfies z.ZodType<ControlRequest>;

export type ControlResponse =
  | Readonly<{ ok: true; output: unknown }>
  | Readonly<{ ok: false; error: string }>;

export const controlResponseSchema = z.discriminatedUnion("ok", [
  z.strictObject({ ok: z.literal(true), output: z.unknown() }),
  z.strictObject({ ok: z.literal(false), error: z.string().min(1) }),
]) satisfies z.ZodType<ControlResponse>;
