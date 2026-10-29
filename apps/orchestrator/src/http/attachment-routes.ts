import type { FastifyInstance } from "fastify";
import {
  AttachmentError,
  MAX_ATTACHMENT_BYTES,
  attachmentDisposition,
  attachmentPayload,
  inlineDisposition,
  type AttachmentService,
} from "../attachments/index.js";
import type { AppDeps } from "./deps.js";
import { HttpError } from "./errors.js";
import { currentOrg, currentUser } from "./identity.js";
import { param } from "./request.js";

/** Chat images: uploaded by an organisation's members and served back to them. */
export async function registerAttachmentRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {

  function attachments(): AttachmentService {
    if (!deps.attachments) {
      throw new AttachmentError(503, "attachments are not configured");
    }
    return deps.attachments;
  }

  app.post(
    "/api/attachments",
    { bodyLimit: MAX_ATTACHMENT_BYTES + 4096 },
    async (request, reply) => {
      const user = await currentUser(deps.db, request, deps);
      const org = await currentOrg(deps.db, request, user);
      if (!Buffer.isBuffer(request.body)) {
        throw new HttpError(422, "body must be the file bytes");
      }
      const row = await attachments().upload({
        orgId: String(org.id),
        userId: user.id,
        filename: String(request.headers["x-filename"] ?? ""),
        bytes: request.body,
      });
      return reply.code(201).send(attachmentPayload(row));
    },
  );

  app.get("/api/attachments/:attachment_id", async (request, reply) => {
    const user = await currentUser(deps.db, request, deps);
    const org = await currentOrg(deps.db, request, user);
    const { row, bytes } = await attachments().getForOrg(
      String(org.id),
      param(request, "attachment_id"),
    );
    const disposition =
      row.kind === "image" ? inlineDisposition(row.filename) : attachmentDisposition(row.filename);
    return reply
      .header("content-type", row.mime)
      .header("x-content-type-options", "nosniff")
      .header("content-disposition", disposition)
      .header("cache-control", "private, max-age=3600")
      .send(bytes);
  });
}
