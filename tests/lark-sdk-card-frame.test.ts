import { describe, expect, it, vi } from "vitest";

import { WSClient } from "@larksuiteoapi/node-sdk";

describe("Lark SDK WebSocket card-frame compatibility", () => {
  it("dispatches and acknowledges card.action.trigger frames", async () => {
    const invoke = vi.fn(async () => undefined);
    const sendMessage = vi.fn();
    const client = new WSClient({
      appId: "cli_0000000000000001",
      appSecret: "secret",
      logger: {
        error: vi.fn(),
        warn: vi.fn(),
        info: vi.fn(),
        debug: vi.fn(),
        trace: vi.fn(),
      },
    }) as unknown as {
      eventDispatcher: { invoke: typeof invoke };
      handleEventData: (frame: unknown) => Promise<void>;
      sendMessage: typeof sendMessage;
    };
    client.eventDispatcher = { invoke };
    client.sendMessage = sendMessage;

    const payload = new TextEncoder().encode(JSON.stringify({
      schema: "2.0",
      header: {
        event_id: "evt_card_1",
        event_type: "card.action.trigger",
      },
      event: {
        context: { open_message_id: "om_card", open_chat_id: "oc_chat" },
        operator: { open_id: "ou_user" },
        action: { tag: "button", value: { cctb_lark: "stop" } },
      },
    }));

    await client.handleEventData({
      method: 1,
      headers: [
        { key: "type", value: "card" },
        { key: "message_id", value: "frame_card_1" },
        { key: "sum", value: "1" },
        { key: "seq", value: "0" },
        { key: "trace_id", value: "trace_card_1" },
      ],
      payload,
    });

    expect(invoke).toHaveBeenCalledOnce();
    expect(sendMessage).toHaveBeenCalledOnce();
    const responseFrame = sendMessage.mock.calls[0]![0] as {
      headers: Array<{ key: string; value: string }>;
      payload: Uint8Array;
    };
    expect(responseFrame.headers).toContainEqual({ key: "type", value: "card" });
    expect(JSON.parse(new TextDecoder().decode(responseFrame.payload))).toEqual({ code: 200 });
  });
});
