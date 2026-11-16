import assert from "node:assert/strict";
import { test } from "node:test";
import { DRIVE_FOLDER_MIME } from "../../src/connectors/drive/folder.js";
import { DRIVE_PATH_UNAVAILABLE, locateDriveFolders } from "../../src/connectors/drive/path.js";
import type { FetchFn } from "../../src/net/http.js";
import { mockFetch, type MockResult } from "../helpers/http.js";

type FakeFile = { name: string; parents?: string[]; driveId?: string };

/** A Drive whose My Drive root is `my_root`, answering each file in `files`, each shared drive in `drives`, and 404 otherwise. */
function fakeDrive(files: Record<string, FakeFile>, drives: Record<string, string> = {}) {
  const reads: string[] = [];
  const client = mockFetch((url): MockResult => {
    const path = new URL(url).pathname;
    const id = decodeURIComponent(path.slice(path.lastIndexOf("/") + 1));
    reads.push(path);
    if (path.includes("/drives/")) {
      return drives[id] ? { status: 200, json: { id, name: drives[id] } } : { status: 404 };
    }
    if (id === "root") {
      return { status: 200, json: { id: "my_root" } };
    }
    const file = files[id];
    return file ? { status: 200, json: { id, mimeType: DRIVE_FOLDER_MIME, ...file } } : { status: 404 };
  });
  return { login: { accessToken: "tok", client }, reads };
}

async function pathOf(login: { accessToken: string; client: FetchFn }, id: string): Promise<string> {
  const [located] = await locateDriveFolders(login, [{ id, name: id }]);
  return located?.path ?? "";
}

test("a nested folder's path climbs to My Drive", async () => {
  const { login } = fakeDrive({
    my_root: { name: "My Drive" },
    projects: { name: "Projects", parents: ["my_root"] },
    reports: { name: "Reports", parents: ["projects"] },
  });
  assert.equal(await pathOf(login, "reports"), "My Drive / Projects / Reports");
});

test("a folder in a shared drive climbs to the shared drive's name", async () => {
  const { login } = fakeDrive(
    {
      team_drive: { name: "Drive", driveId: "team_drive" },
      specs: { name: "Specs", parents: ["team_drive"], driveId: "team_drive" },
    },
    { team_drive: "Engineering" },
  );
  assert.equal(await pathOf(login, "specs"), "Engineering / Specs");
  assert.equal(await pathOf(login, "team_drive"), "Engineering");
});

test("a path is unavailable when a parent cannot be read, and invents no ancestor", async () => {
  const { login } = fakeDrive({
    shared_child: { name: "Child", parents: ["hidden_parent"] },
    shared_top: { name: "Shared with me" },
  });
  assert.equal(await pathOf(login, "shared_child"), DRIVE_PATH_UNAVAILABLE);
  assert.equal(await pathOf(login, "shared_top"), DRIVE_PATH_UNAVAILABLE);
  assert.equal(await pathOf(login, "gone"), DRIVE_PATH_UNAVAILABLE);
});

test("a path is unavailable when the shared drive or the My Drive root cannot be read", async () => {
  const sharedGone = fakeDrive({ orphan_drive: { name: "Drive", driveId: "orphan_drive" } });
  assert.equal(await pathOf(sharedGone.login, "orphan_drive"), DRIVE_PATH_UNAVAILABLE);
  const client = mockFetch((url) => {
    const path = new URL(url).pathname;
    if (path.endsWith("/files/root")) {
      return { status: 500, json: { error: { message: "backend error" } } };
    }
    return { status: 200, json: { id: "top", name: "Top", mimeType: DRIVE_FOLDER_MIME } };
  });
  assert.equal(await pathOf({ accessToken: "tok", client }, "top"), DRIVE_PATH_UNAVAILABLE);
});

test("a path is unavailable when Drive fails on a parent", async () => {
  const client = mockFetch((url) => {
    const path = new URL(url).pathname;
    if (path.endsWith("/files/child")) {
      return { status: 200, json: { id: "child", name: "Child", parents: ["parent"] } };
    }
    return { status: 503, json: { error: { message: "unavailable" } } };
  });
  assert.equal(await pathOf({ accessToken: "tok", client }, "child"), DRIVE_PATH_UNAVAILABLE);
});

test("a path through a cycle of parents is unavailable", async () => {
  const { login } = fakeDrive({
    loop_a: { name: "A", parents: ["loop_b"] },
    loop_b: { name: "B", parents: ["loop_a"] },
  });
  assert.equal(await pathOf(login, "loop_a"), DRIVE_PATH_UNAVAILABLE);
});

test("a path deeper than the climb allows is unavailable", async () => {
  const files: Record<string, FakeFile> = { my_root: { name: "My Drive" } };
  let parent = "my_root";
  for (let depth = 0; depth < 40; depth += 1) {
    files[`level_${depth}`] = { name: `Level ${depth}`, parents: [parent] };
    parent = `level_${depth}`;
  }
  const { login, reads } = fakeDrive(files);
  assert.equal(await pathOf(login, "level_39"), DRIVE_PATH_UNAVAILABLE);
  assert.ok(reads.length <= 33, `climbed ${reads.length} files`);
  assert.equal(await pathOf(login, "level_20"), `My Drive / ${Array.from({ length: 21 }, (_, i) => `Level ${i}`).join(" / ")}`);
});

test("folders of the same name tell apart by path, and read shared parents once", async () => {
  const { login, reads } = fakeDrive({
    my_root: { name: "My Drive" },
    clients: { name: "Clients", parents: ["my_root"] },
    archive: { name: "Archive", parents: ["clients"] },
    current: { name: "Invoices", parents: ["clients"] },
    archived: { name: "Invoices", parents: ["archive"] },
  });
  const located = await locateDriveFolders(login, [
    { id: "current", name: "Invoices" },
    { id: "archived", name: "Invoices" },
  ]);
  assert.deepEqual(located, [
    { id: "current", name: "Invoices", path: "My Drive / Clients / Invoices" },
    { id: "archived", name: "Invoices", path: "My Drive / Clients / Archive / Invoices" },
  ]);
  assert.equal(reads.filter((path) => path.endsWith("/files/clients")).length, 1);
  assert.equal(reads.filter((path) => path.endsWith("/files/root")).length, 1);
});

test("a path is unavailable when a parent, the shared drive, or the My Drive root cannot be reached", async () => {
  const answers: Record<string, object> = {
    "/files/child": { id: "child", name: "Child", parents: ["parent"] },
    "/files/parent": { id: "parent", name: "Parent", parents: ["my_root"] },
    "/files/team_drive": { id: "team_drive", name: "Drive", driveId: "team_drive" },
    "/files/root": { id: "my_root" },
    "/files/my_root": { id: "my_root", name: "My Drive" },
    "/drives/team_drive": { id: "team_drive", name: "Engineering" },
  };
  const expected: Record<string, [string, string]> = {
    "/files/parent": [DRIVE_PATH_UNAVAILABLE, "Engineering"],
    "/drives/team_drive": ["My Drive / Parent / Child", DRIVE_PATH_UNAVAILABLE],
    "/files/root": [DRIVE_PATH_UNAVAILABLE, "Engineering"],
  };
  for (const [unreachable, paths] of Object.entries(expected)) {
    const client: FetchFn = async (url) => {
      const path = new URL(url).pathname.replace("/drive/v3", "");
      if (path === unreachable) {
        throw new TypeError("fetch failed");
      }
      return Response.json(answers[path]);
    };
    const located = await locateDriveFolders({ accessToken: "tok", client }, [
      { id: "child", name: "Child" },
      { id: "team_drive", name: "Engineering" },
    ]);
    assert.deepEqual(
      located,
      [
        { id: "child", name: "Child", path: paths[0] },
        { id: "team_drive", name: "Engineering", path: paths[1] },
      ],
      `${unreachable} unreachable`,
    );
  }
});

test("a path is unavailable when a folder on the way up has a blank name", async () => {
  const { login } = fakeDrive({
    my_root: { name: "My Drive" },
    unnamed: { name: "   ", parents: ["my_root"] },
    reports: { name: "Reports", parents: ["unnamed"] },
  });
  assert.equal(await pathOf(login, "reports"), DRIVE_PATH_UNAVAILABLE);
});

test("a path is unavailable when the connection drops while a parent's answer is read", async () => {
  const client: FetchFn = async (url) => {
    const path = new URL(url).pathname;
    if (path.endsWith("/files/parent")) {
      return new Response(
        new ReadableStream({
          start: (controller) => controller.error(new TypeError("terminated")),
        }),
      );
    }
    return Response.json({ id: "child", name: "Child", parents: ["parent"] });
  };
  assert.equal(await pathOf({ accessToken: "tok", client }, "child"), DRIVE_PATH_UNAVAILABLE);
});

test("a failure in reading Drive's answer is not taken for an unreadable path", async () => {
  const client: FetchFn = async () =>
    ({
      status: 200,
      text: () => {
        throw new RangeError("unexpected");
      },
    }) as unknown as Response;
  await assert.rejects(() => pathOf({ accessToken: "tok", client }, "any"), RangeError);
});
