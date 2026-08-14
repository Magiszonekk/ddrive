import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { db } from "@ddv4/database";
import { createYoga } from "graphql-yoga";
import { buildSchema } from "../../schema.js";
import { initUpload, commitManifest } from "../../resolvers/files.js";
import { createShare, accessShare } from "../../resolvers/sharing.js";
import { handleBlobContent, handleBlobUpload } from "../../handlers/blob.js";

vi.mock("../../plugin-registry.js", () => ({
  pluginRegistry: {
    emitAsync: vi.fn().mockResolvedValue(undefined),
    getGraphqlExtensions: vi.fn().mockReturnValue({ typeDefs: [], resolvers: [] }),
  },
}));

const smokeSchema = buildSchema();
const yoga = createYoga({ schema: smokeSchema, graphqlEndpoint: "/graphql" });

type GraphqlResult<T> = { data?: T; errors?: Array<{ message: string }> };

type AuthPayload = {
  token: string;
  user: {
    id: string;
    email: string;
    username: string | null;
  };
};

const smokeUser = {
  email: "core-v1-smoke@example.com",
  username: "core-v1-smoke",
  password: "smoke-test-password-123!",
};

const manifestBlobId = "manifest-derived-core-v1-smoke";
const content = new Uint8Array([11, 22, 33, 44, 55, 66]);

async function resetSmokeFixtures() {
  await db.share.deleteMany({ where: { ownerUserId: smokeUser.username } }).catch(() => undefined);
  await db.blobTransport.deleteMany({ where: { ownerUserId: smokeUser.username } }).catch(() => undefined);
  await db.file.deleteMany({ where: { ownerUserId: smokeUser.username } }).catch(() => undefined);
  await db.user.deleteMany({ where: { email: smokeUser.email } });
}

async function execGraphql<T>(query: string, variables?: Record<string, unknown>, token?: string): Promise<T> {
  const request = new Request("http://localhost/graphql", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ query, variables }),
  });

  const response = await yoga.fetch(request);
  const result = (await response.json()) as GraphqlResult<T>;
  expect(result.errors).toBeUndefined();
  expect(result.data).toBeDefined();
  return result.data as T;
}

describe("core v1 smoke flow", () => {
  let tempBlobRoot: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    tempBlobRoot = await mkdtemp(path.join(os.tmpdir(), "ddv4-core-v1-smoke-"));
    process.env.DDV4_BLOB_ROOT_DIR = tempBlobRoot;
    delete process.env.BLOB_STORAGE_KIND;
    await resetSmokeFixtures();
  });

  afterEach(async () => {
    delete process.env.DDV4_BLOB_ROOT_DIR;
    delete process.env.BLOB_STORAGE_KIND;
    await rm(tempBlobRoot, { recursive: true, force: true });
  });

  it("runs register -> login -> initUpload -> blob upload -> commitManifest -> owner fetch -> share access", async () => {
    const registerData = await execGraphql<{ register: AuthPayload }>(
      /* GraphQL */ `
        mutation Register($email: String!, $username: String!, $password: String!) {
          register(email: $email, username: $username, password: $password) {
            token
            user { id email username }
          }
        }
      `,
      smokeUser,
    );

    expect(registerData.register.user.email).toBe(smokeUser.email);

    const loginData = await execGraphql<{ login: AuthPayload }>(
      /* GraphQL */ `
        mutation Login($emailOrUsername: String!, $password: String!) {
          login(emailOrUsername: $emailOrUsername, password: $password) {
            token
            user { id email username }
          }
        }
      `,
      { emailOrUsername: smokeUser.email, password: smokeUser.password },
    );

    expect(loginData.login.user.id).toBe(registerData.register.user.id);

    const ownerToken = loginData.login.token;
    const ownerUserId = loginData.login.user.id;

    const initUploadData = await initUpload(ownerUserId, {
      totalBytes: content.byteLength.toString(),
      chunkCount: 1,
    });

    expect(initUploadData.status).toBe("uploading");

    const uploadResponse = await handleBlobUpload(
      new Request(`http://localhost/api/blob/${manifestBlobId}`, {
        method: "PUT",
        headers: { authorization: `Bearer ${ownerToken}` },
        body: content,
      }),
      { blobId: manifestBlobId },
    );

    expect(uploadResponse.status).toBe(200);
    await expect(uploadResponse.json()).resolves.toMatchObject({
      blobId: manifestBlobId,
      sizeBytes: content.byteLength.toString(),
    });

    const commitData = await commitManifest(
      ownerUserId,
      initUploadData.fileId,
      manifestBlobId,
      content.byteLength.toString(),
      1,
      [
        {
          blobId: manifestBlobId,
          storageKind: "LOCAL",
          storagePath: path.join(tempBlobRoot, manifestBlobId),
          sizeBytes: content.byteLength.toString(),
        },
      ],
    );

    expect(commitData.success).toBe(true);

    const blobContentResponse = await handleBlobContent(
      new Request(`http://localhost/api/blob/${manifestBlobId}`, {
        method: "GET",
        headers: { authorization: `Bearer ${ownerToken}` },
      }),
      { blobId: manifestBlobId },
    );

    expect(blobContentResponse.status).toBe(200);
    expect(new Uint8Array(await blobContentResponse.arrayBuffer())).toEqual(content);

    const createShareData = await createShare(ownerUserId, {
      fileId: initUploadData.fileId,
      allowContent: true,
      allowPreview: false,
    });

    const accessShareData = await accessShare(createShareData.shareId, createShareData.token);

    expect(accessShareData).toMatchObject({
      shareId: createShareData.shareId,
      fileId: initUploadData.fileId,
      allowContent: true,
      allowPreview: false,
    });
  });
});
