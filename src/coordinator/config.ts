import { isIP } from "node:net";
import path from "node:path";
import { z, ZodError } from "zod";

const coordinatorEnvironmentSchema = z
  .object({
    SPIRE_COORDINATOR_TOKEN: z
      .string({ error: "SPIRE_COORDINATOR_TOKEN is required." })
      .min(1, "SPIRE_COORDINATOR_TOKEN is required."),
    SPIRE_COORDINATOR_HOST: z.string().min(1).default("127.0.0.1"),
    SPIRE_COORDINATOR_PORT: z.preprocess(
      (value) => value ?? "43110",
      z
        .string()
        .regex(/^\d+$/, "SPIRE_COORDINATOR_PORT must be an integer.")
        .transform(Number)
        .pipe(
          z
            .number()
            .int("SPIRE_COORDINATOR_PORT must be an integer.")
            .min(0, "SPIRE_COORDINATOR_PORT must be at least zero.")
            .max(65535, "SPIRE_COORDINATOR_PORT must be at most 65535."),
        ),
    ),
    SPIRE_USER_DATA: z.string().min(1).optional(),
    SPIRE_ALLOW_REMOTE: z.literal("1").optional().transform((value) => value === "1"),
    SPIRE_COORDINATOR_TLS_CERT: z.string().min(1).optional(),
    SPIRE_COORDINATOR_TLS_KEY: z.string().min(1).optional(),
    NODE_ENV: z.string().optional(),
  })
  .superRefine((environment, context) => {
    if (environment.SPIRE_COORDINATOR_PORT === 0 && environment.NODE_ENV !== "test") {
      context.addIssue({
        code: "custom",
        path: ["SPIRE_COORDINATOR_PORT"],
        message: "SPIRE_COORDINATOR_PORT may only be zero when NODE_ENV=test.",
      });
    }
    const hasCertificate = environment.SPIRE_COORDINATOR_TLS_CERT !== undefined;
    const hasPrivateKey = environment.SPIRE_COORDINATOR_TLS_KEY !== undefined;
    if (hasCertificate !== hasPrivateKey) {
      context.addIssue({
        code: "custom",
        path: [hasCertificate ? "SPIRE_COORDINATOR_TLS_KEY" : "SPIRE_COORDINATOR_TLS_CERT"],
        message: "SPIRE_COORDINATOR_TLS_CERT and SPIRE_COORDINATOR_TLS_KEY must be configured together.",
      });
    }
    const isRemote = !isLoopbackHost(environment.SPIRE_COORDINATOR_HOST);
    if (!environment.SPIRE_ALLOW_REMOTE && isRemote) {
      context.addIssue({
        code: "custom",
        path: ["SPIRE_COORDINATOR_HOST"],
        message: "SPIRE_COORDINATOR_HOST must be loopback unless SPIRE_ALLOW_REMOTE=1.",
      });
    }
    if (isRemote && (!hasCertificate || !hasPrivateKey)) {
      context.addIssue({
        code: "custom",
        path: ["SPIRE_COORDINATOR_TLS_CERT"],
        message: "Remote coordinator binding requires SPIRE_COORDINATOR_TLS_CERT and SPIRE_COORDINATOR_TLS_KEY.",
      });
    }
  });

export class CoordinatorConfigurationError extends Error {
  override readonly name = "CoordinatorConfigurationError";
}

export type CoordinatorConfig = Readonly<{
  token: string;
  host: string;
  port: number;
  dataRoot: string;
  tls: Readonly<{
    certificatePath: string;
    privateKeyPath: string;
  }> | undefined;
}>;

export function isLoopbackHost(host: string): boolean {
  return host === "::1" || (isIP(host) === 4 && host.startsWith("127."));
}

export function readCoordinatorConfig(
  environment: NodeJS.ProcessEnv,
  cwd: string,
): CoordinatorConfig {
  let parsed: z.infer<typeof coordinatorEnvironmentSchema>;
  try {
    parsed = coordinatorEnvironmentSchema.parse(environment);
  } catch (error: unknown) {
    if (error instanceof ZodError) {
      throw new CoordinatorConfigurationError(
        error.issues[0]?.message ?? "Invalid coordinator configuration.",
      );
    }
    throw error;
  }
  return {
    token: parsed.SPIRE_COORDINATOR_TOKEN,
    host: parsed.SPIRE_COORDINATOR_HOST,
    port: parsed.SPIRE_COORDINATOR_PORT,
    dataRoot: parsed.SPIRE_USER_DATA ?? path.join(cwd, ".spire-data"),
    tls: parsed.SPIRE_COORDINATOR_TLS_CERT && parsed.SPIRE_COORDINATOR_TLS_KEY
      ? {
          certificatePath: parsed.SPIRE_COORDINATOR_TLS_CERT,
          privateKeyPath: parsed.SPIRE_COORDINATOR_TLS_KEY,
        }
      : undefined,
  };
}
