import { describe, expect, it } from "vitest";
import type Docker from "dockerode";
import { DockerodeDriver, type ContainerSpec } from "../src/server/docker/driver.js";

const base: ContainerSpec = { name: "gl-x", image: "img", env: {}, ports: [], binds: [], labels: {} };

/** A Docker client that records what the container is created with. */
function fakeClient() {
  const created: { HostConfig: Record<string, unknown> }[] = [];
  const docker = {
    listContainers: async () => [],
    createContainer: async (o: { HostConfig: Record<string, unknown> }) => (created.push(o), { id: "abc" }),
  } as unknown as Docker;
  return { driver: new DockerodeDriver(docker), created };
}

describe("DockerodeDriver resource limits", () => {
  it("sets nothing when no limit is asked for", async () => {
    const { driver, created } = fakeClient();
    await driver.create(base);
    expect(created[0].HostConfig).not.toHaveProperty("NanoCpus");
    expect(created[0].HostConfig).not.toHaveProperty("Memory");
    expect(created[0].HostConfig).not.toHaveProperty("MemorySwap");
  });

  it("sets a CPU cap and a memory cap with no swap on top", async () => {
    const { driver, created } = fakeClient();
    await driver.create({ ...base, nanoCpus: 2_500_000_000, memoryBytes: 4 * 1024 ** 3 });
    expect(created[0].HostConfig).toMatchObject({ NanoCpus: 2_500_000_000, Memory: 4 * 1024 ** 3, MemorySwap: 4 * 1024 ** 3 });
  });
});
