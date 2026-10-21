import { test } from "bun:test";
import { strict as assert } from "node:assert";

import { waitFor } from "@jointarp/module/testing/async";
import { MutationObserver, QueryClient } from "@tanstack/react-query";

import { roomDisplayMutation } from "./room-display-mutation";

function fixture() {
  const client = new QueryClient();
  const queryKey = ["display", "test-room"];
  let stored = { showReasoning: false, showAllDocuments: false };
  const requests: { resolve: () => void; reject: () => void }[] = [];
  const save = (patch: Partial<typeof stored>) =>
    new Promise<typeof stored>((resolve, reject) => {
      requests.push({
        resolve: () => {
          stored = { ...stored, ...patch };
          resolve(stored);
        },
        reject: () => reject(new Error("保存失败")),
      });
    });
  client.setQueryData(queryKey, stored);
  const mutation = new MutationObserver(
    client,
    roomDisplayMutation(client, queryKey, "test-room", save, () => {}),
  );
  return { client, queryKey, mutation, requests };
}

test("两开关快速开启立即生效，旧保存响应不会使另一个开关闪回", async () => {
  const f = fixture();
  try {
    const first = f.mutation.mutate({ key: "showReasoning", value: true });
    const second = f.mutation.mutate({ key: "showAllDocuments", value: true });
    assert.deepEqual(f.client.getQueryData(f.queryKey), {
      showReasoning: true,
      showAllDocuments: true,
    });
    await waitFor(() => assert.equal(f.requests.length, 1));
    f.requests[0]!.resolve();
    await first;
    assert.deepEqual(f.client.getQueryData(f.queryKey), {
      showReasoning: true,
      showAllDocuments: true,
    });
    await waitFor(() => assert.equal(f.requests.length, 2));
    f.requests[1]!.resolve();
    await second;
  } finally {
    f.client.clear();
  }
});

test("同一开关连续切换保留最后操作，保存失败只回退自身到已保存值", async () => {
  const f = fixture();
  try {
    const first = f.mutation.mutate({ key: "showReasoning", value: true });
    const second = assert.rejects(
      f.mutation.mutate({ key: "showReasoning", value: false }),
      /保存失败/,
    );
    const third = f.mutation.mutate({ key: "showAllDocuments", value: true });
    await waitFor(() => assert.equal(f.requests.length, 1));
    f.requests[0]!.resolve();
    await first;
    assert.deepEqual(f.client.getQueryData(f.queryKey), {
      showReasoning: false,
      showAllDocuments: true,
    });
    await waitFor(() => assert.equal(f.requests.length, 2));
    f.requests[1]!.reject();
    await second;
    assert.deepEqual(f.client.getQueryData(f.queryKey), {
      showReasoning: true,
      showAllDocuments: true,
    });
    await waitFor(() => assert.equal(f.requests.length, 3));
    f.requests[2]!.resolve();
    await third;
  } finally {
    f.client.clear();
  }
});
