import { describe, expect, it, vi } from "vitest";
import {
  closeRenderQueue,
  getRenderQueueJobId,
  RENDER_QUEUE_NAME,
} from "../../apps/api/src/render-queue.js";

describe("render queue", () => {
  it("uses a dedicated queue and deterministic job id", () => {
    expect(RENDER_QUEUE_NAME).toBe("artwork-render");
    expect(getRenderQueueJobId("job-123")).toBe("render:job-123");
  });

  it("tolerates Redis already being unavailable during shutdown", async () => {
    const close = vi.fn().mockRejectedValue(new Error("redis unavailable"));
    await expect(closeRenderQueue({ close } as never)).resolves.toBeUndefined();
    expect(close).toHaveBeenCalledOnce();
  });
});
