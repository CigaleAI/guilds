import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DRIVE_FOLDER_MIME,
  DriveFolderError,
  assertPickedDriveFolder,
  constrainDriveTool,
  fileInDriveFolder,
  filterDriveToolResult,
  searchDriveFolders,
  parseDriveFolderRef,
  searchDriveFolder,
  translateDriveSearchQuery,
} from "../../src/connectors/drive/folder.js";
import drive from "../../src/connectors/drive/adapter.js";
import { ConnectorError } from "../../src/connectors/types.js";
import { mockFetch } from "../helpers/http.js";

test("parseDriveFolderRef accepts ids and Drive folder links", () => {
  assert.equal(parseDriveFolderRef(" folder_1 "), "folder_1");
  assert.equal(parseDriveFolderRef("https://drive.google.com/drive/folders/abc_12"), "abc_12");
  assert.equal(parseDriveFolderRef("https://drive.google.com/drive/u/0/folders/xyz-9"), "xyz-9");
  assert.equal(parseDriveFolderRef("https://drive.google.com/open?id=open_1"), "open_1");
  assert.equal(parseDriveFolderRef("drive:shared_1"), "shared_1");
  assert.throws(() => parseDriveFolderRef(""), DriveFolderError);
  assert.throws(() => parseDriveFolderRef("https://example.com/x"), DriveFolderError);
});

test("assertPickedDriveFolder rejects My Drive", async () => {
  await assert.rejects(
    () =>
      assertPickedDriveFolder("tok", "root", {
        client: mockFetch(() => ({ status: 200, json: { id: "root_real", name: "My Drive", mimeType: DRIVE_FOLDER_MIME } })),
      }),
    DriveFolderError,
  );
  await assert.rejects(
    () =>
      assertPickedDriveFolder("tok", "folder_1", {
        client: mockFetch((url) => {
          if (String(url).includes("/files/root")) {
            return { status: 200, json: { id: "folder_1" } };
          }
          return { status: 200, json: { id: "folder_1", name: "My Drive", mimeType: DRIVE_FOLDER_MIME } };
        }),
      }),
    /not My Drive/,
  );
});

test("fileInDriveFolder walks parents", async () => {
  const client = mockFetch((url) => {
    const path = new URL(url).pathname;
    if (path.endsWith("/files/doc_1")) {
      return { status: 200, json: { id: "doc_1", name: "Doc", mimeType: "text/plain", parents: ["sub_1"] } };
    }
    if (path.endsWith("/files/sub_1")) {
      return {
        status: 200,
        json: { id: "sub_1", name: "Sub", mimeType: DRIVE_FOLDER_MIME, parents: ["folder_1"] },
      };
    }
    return { status: 404 };
  });
  assert.equal(await fileInDriveFolder("tok", "folder_1", "folder_1", { client }), true);
  assert.equal(await fileInDriveFolder("tok", "doc_1", "folder_1", { client }), true);
  assert.equal(await fileInDriveFolder("tok", "doc_1", "other", { client }), false);
});

test("constrainDriveTool pins creates and rejects files outside the folder", async () => {
  const client = mockFetch((url) => {
    const path = new URL(url).pathname;
    if (path.endsWith("/files/inside")) {
      return {
        status: 200,
        json: { id: "inside", name: "In", mimeType: "text/plain", parents: ["folder_1"] },
      };
    }
    if (path.endsWith("/files/outside")) {
      return {
        status: 200,
        json: { id: "outside", name: "Out", mimeType: "text/plain", parents: ["root"] },
      };
    }
    return { status: 404 };
  });
  const scoped = { accessToken: "tok", folderId: "folder_1", client };
  assert.deepEqual(await constrainDriveTool("create_file", { title: "n" }, scoped), {
    title: "n",
    parentId: "folder_1",
  });
  await constrainDriveTool("read_file_content", { fileId: "inside" }, scoped);
  await assert.rejects(
    () => constrainDriveTool("read_file_content", { fileId: "outside" }, scoped),
    /limited to the connected folder/,
  );
  await assert.rejects(
    () => constrainDriveTool("search_files", { query: "parentId != 'folder_1'" }, scoped),
    /cannot exclude/,
  );
});

test("filterDriveToolResult keeps files in the connected folder", async () => {
  const client = mockFetch((url) => {
    const path = new URL(url).pathname;
    if (path.endsWith("/files/keep")) {
      return {
        status: 200,
        json: { id: "keep", name: "Keep", mimeType: "text/plain", parents: ["folder_1"] },
      };
    }
    if (path.endsWith("/files/drop")) {
      return {
        status: 200,
        json: { id: "drop", name: "Drop", mimeType: "text/plain", parents: ["elsewhere"] },
      };
    }
    return { status: 404 };
  });
  const scoped = { accessToken: "tok", folderId: "folder_1", client };
  const filtered = await filterDriveToolResult(
    "search_files",
    JSON.stringify({
      files: [
        { id: "keep", title: "Keep", parentId: "folder_1" },
        { id: "drop", title: "Drop", parentId: "elsewhere" },
      ],
    }),
    scoped,
  );
  assert.deepEqual(JSON.parse(filtered), {
    files: [{ id: "keep", title: "Keep", parentId: "folder_1" }],
  });
  assert.deepEqual(JSON.parse(await filterDriveToolResult("search_files", "", scoped)), { files: [] });
  assert.deepEqual(JSON.parse(await filterDriveToolResult("search_files", "{}", scoped)), { files: [] });
  assert.deepEqual(
    JSON.parse(
      await filterDriveToolResult(
        "search_files",
        {
          content: [{ type: "text", text: "3 files" }],
          structuredContent: {
            files: [
              { id: "keep", title: "Keep", parentId: "folder_1" },
              { id: "drop", title: "Drop", parentId: "elsewhere" },
            ],
            nextPageToken: "p2",
          },
        },
        scoped,
      ),
    ),
    { files: [{ id: "keep", title: "Keep", parentId: "folder_1" }], nextPageToken: "p2" },
  );
  assert.equal(
    await filterDriveToolResult(
      "search_files",
      { isError: true, content: [{ type: "text", text: "Invalid query: use title contains 'x'" }] },
      scoped,
    ),
    "Invalid query: use title contains 'x'",
  );
});

test("Drive 403 explains missing Drive scope and API not enabled", async () => {
  await assert.rejects(
    () =>
      searchDriveFolders("tok", "agents", {
        client: mockFetch(() => ({
          status: 403,
          json: {
            error: {
              message: "Request had insufficient authentication scopes.",
              status: "PERMISSION_DENIED",
              details: [{ reason: "ACCESS_TOKEN_SCOPE_INSUFFICIENT" }],
            },
          },
        })),
      }),
    /full Drive access/,
  );
  await assert.rejects(
    () =>
      searchDriveFolders("tok", "agents", {
        client: mockFetch(() => ({
          status: 403,
          json: {
            error: {
              message: "Google Drive API has not been used in project 1 before or it is disabled.",
              errors: [{ reason: "accessNotConfigured" }],
            },
          },
        })),
      }),
    /Drive API is not enabled/,
  );
  const listed = await searchDriveFolders("tok", "it's", {
    client: mockFetch((url) => {
      const parsed = new URL(url);
      assert.equal(parsed.searchParams.get("includeItemsFromAllDrives"), "true");
      assert.equal(parsed.searchParams.get("corpora"), "allDrives");
      assert.match(String(parsed.searchParams.get("q")), /name contains 'it\\'s'/);
      return { status: 200, json: { files: [{ id: "a", name: "Zed" }, { id: "b", name: "Agents" }] } };
    }),
  });
  assert.deepEqual(
    listed.map((folder) => folder.name),
    ["Agents", "Zed"],
  );
});

test("translateDriveSearchQuery maps MCP terms", () => {
  assert.equal(translateDriveSearchQuery("title contains 'notes'"), "name contains 'notes'");
  assert.equal(translateDriveSearchQuery("parentId = 'abc'"), "'abc' in parents");
  assert.equal(
    translateDriveSearchQuery("reports"),
    "(name contains 'reports' or fullText contains 'reports')",
  );
});

test("searchDriveFolder uses Shared drive corpus and keeps folder files", async () => {
  const client = mockFetch((url) => {
    const parsed = new URL(url);
    if (parsed.pathname.endsWith("/files/folder_1") && parsed.searchParams.get("fields") === "id,driveId") {
      return { status: 200, json: { id: "folder_1", driveId: "sd_1" } };
    }
    if (parsed.pathname.endsWith("/files") && parsed.searchParams.has("q")) {
      assert.equal(parsed.searchParams.get("corpora"), "drive");
      assert.equal(parsed.searchParams.get("driveId"), "sd_1");
      assert.equal(parsed.searchParams.get("includeItemsFromAllDrives"), "true");
      assert.equal(parsed.searchParams.get("supportsAllDrives"), "true");
      assert.match(parsed.searchParams.get("q") ?? "", /name contains 'notes'/);
      return {
        status: 200,
        json: {
          files: [
            { id: "keep", name: "Notes", mimeType: "text/plain", parents: ["folder_1"] },
            { id: "drop", name: "Other", mimeType: "text/plain", parents: ["elsewhere"] },
          ],
        },
      };
    }
    return { status: 404 };
  });
  const text = await searchDriveFolder("tok", "folder_1", { query: "title contains 'notes'" }, { client });
  assert.deepEqual(JSON.parse(text), {
    files: [{ id: "keep", title: "Notes", parentId: "folder_1", mimeType: "text/plain" }],
  });
});

test("Drive's adapter looks up folders by name or link and validates the picked one", async () => {
  const folderFetch = mockFetch((url) => {
    const parsed = new URL(url);
    if (parsed.pathname.endsWith("/files/root")) {
      return { status: 200, json: { id: "root_real" } };
    }
    if (parsed.pathname.endsWith("/files")) {
      assert.match(String(parsed.searchParams.get("q")), /name contains 'inbox'/);
      return { status: 200, json: { files: [{ id: "fold_1", name: "Inbox" }] } };
    }
    if (parsed.pathname.endsWith("/files/1AbCdEfGhIjKlMnOpQrStUv")) {
      return { status: 200, json: { id: "1AbCdEfGhIjKlMnOpQrStUv", name: "Shared", mimeType: DRIVE_FOLDER_MIME } };
    }
    if (parsed.pathname.endsWith("/files/fold_1")) {
      return { status: 200, json: { id: "fold_1", name: "Inbox", mimeType: DRIVE_FOLDER_MIME } };
    }
    return { status: 404 };
  });
  const ctx = (settings: Record<string, unknown>) => ({
    http: folderFetch,
    remote: { initialize: async () => ({ name: "", instructions: "" }), list: async () => [], call: async () => "" },
    connection_id: "conn_drive",
    settings,
  });
  assert.deepEqual(await drive.lookup!("folder_id", "inbox", { access_token: "tok" }, ctx({})), [
    { value: "fold_1", label: "Inbox" },
  ]);
  assert.deepEqual(
    await drive.lookup!(
      "folder_id",
      "https://drive.google.com/drive/folders/1AbCdEfGhIjKlMnOpQrStUv",
      { access_token: "tok" },
      ctx({}),
    ),
    [{ value: "1AbCdEfGhIjKlMnOpQrStUv", label: "Shared" }],
  );
  assert.equal(await drive.validate!({ access_token: "tok" }, ctx({ folder_id: "fold_1" })), "Inbox");
  await assert.rejects(
    () => drive.validate!({ access_token: "tok" }, ctx({ folder_id: "root" })),
    (error: unknown) => error instanceof ConnectorError && error.status === 422,
  );
});
