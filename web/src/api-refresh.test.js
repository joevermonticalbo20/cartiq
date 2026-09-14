import { describe, it, expect, vi, beforeEach } from "vitest";

const inst = vi.hoisted(() => {
  const h = {
    responseError: null,
    requestMock: null,
    postMock: null,
  };
  const apiInstance = (config) => h.requestMock(config);
  apiInstance.request = (config) => h.requestMock(config);
  apiInstance.interceptors = {
    request: { use: () => {} },
    response: {
      use: (ok, err) => {
        h.responseError = err;
      },
    },
  };
  return { h, apiInstance };
});

vi.mock("axios", () => ({
  default: {
    create: () => inst.apiInstance,
    post: (...args) => inst.h.postMock(...args),
  },
}));

// Fresh module per test: wipes refreshPromise/redirecting state so tests
// can never leak into each other through the singleton client.
async function loadApi() {
  vi.resetModules();
  return import("./api.js");
}

function useBackingStore(seed = {}) {
  const store = { ...seed };
  vi.mocked(localStorage.getItem).mockImplementation((k) => store[k] ?? null);
  vi.mocked(localStorage.setItem).mockImplementation((k, v) => {
    store[k] = String(v);
  });
  vi.mocked(localStorage.removeItem).mockImplementation((k) => {
    delete store[k];
  });
  return store;
}

function fail401(url = "/orders") {
  return {
    response: { status: 401, data: {} },
    config: { url, headers: {} },
  };
}

describe("auth interceptor refresh flow", () => {
  let navigate;

  beforeEach(() => {
    vi.clearAllMocks();
    navigate = vi.fn();
    inst.h.requestMock = vi.fn().mockResolvedValue({ data: { ok: true } });
    inst.h.postMock = vi.fn();
  });

  it("retries once with a fresh token after silent refresh", async () => {
    const { setupAuthInterceptor } = await loadApi();
    setupAuthInterceptor(navigate);
    const store = useBackingStore({
      cartiq_token: "expired-access",
      cartiq_refresh_token: "stored-refresh",
    });
    inst.h.postMock.mockResolvedValue({
      data: { token: "new-access", refreshToken: "new-refresh" },
    });

    const result = await inst.h.responseError(fail401());

    expect(inst.h.postMock).toHaveBeenCalledTimes(1);
    expect(inst.h.postMock).toHaveBeenCalledWith("/api/auth/refresh", {
      refreshToken: "stored-refresh",
    });
    expect(store.cartiq_token).toBe("new-access");
    expect(store.cartiq_refresh_token).toBe("new-refresh");
    expect(inst.h.requestMock).toHaveBeenCalledTimes(1);
    expect(inst.h.requestMock.mock.calls[0][0].headers.Authorization).toBe(
      "Bearer new-access"
    );
    expect(inst.h.requestMock.mock.calls[0][0]._retry).toBe(true);
    expect(result).toEqual({ data: { ok: true } });
    expect(navigate).not.toHaveBeenCalled();
  });

  it("stays logged in when a refreshed retry still 401s (endpoint-level rejection)", async () => {
    const { setupAuthInterceptor } = await loadApi();
    setupAuthInterceptor(navigate);
    const store = useBackingStore({
      cartiq_token: "expired-access",
      cartiq_refresh_token: "stored-refresh",
    });
    inst.h.postMock.mockResolvedValue({
      data: { token: "new-access", refreshToken: "new-refresh" },
    });
    // First 401 triggers refresh + retry; capture the retried config.
    inst.h.requestMock.mockRejectedValueOnce(fail401());
    await expect(inst.h.responseError(fail401())).rejects.toBeDefined();
    const retried = inst.h.requestMock.mock.calls[0][0];
    expect(retried._retry).toBe(true);
    expect(retried._refreshed).toBe(true);

    // The retried call 401s again despite the fresh token: endpoint-level
    // rejection (wrong credential type), NOT a dead session.
    await expect(
      inst.h.responseError({
        response: { status: 401, data: {} },
        config: retried,
      })
    ).rejects.toBeDefined();
    expect(store.cartiq_token).toBe("new-access");
    expect(store.cartiq_refresh_token).toBe("new-refresh");
    expect(navigate).not.toHaveBeenCalled();
  });

  it("logs out when refresh fails", async () => {
    const { setupAuthInterceptor } = await loadApi();
    setupAuthInterceptor(navigate);
    const store = useBackingStore({
      cartiq_token: "expired-access",
      cartiq_refresh_token: "dead-refresh",
    });
    inst.h.postMock.mockRejectedValue({
      response: { status: 401, data: {} },
    });

    await expect(inst.h.responseError(fail401())).rejects.toBeDefined();
    expect(store.cartiq_token).toBeUndefined();
    expect(store.cartiq_refresh_token).toBeUndefined();
    expect(navigate).toHaveBeenCalledWith("/login", { replace: true });
    expect(inst.h.requestMock).not.toHaveBeenCalled();
  });

  it("logs out when no refresh token is stored", async () => {
    const { setupAuthInterceptor } = await loadApi();
    setupAuthInterceptor(navigate);
    useBackingStore({ cartiq_token: "expired-access" });

    await expect(inst.h.responseError(fail401())).rejects.toBeDefined();
    expect(inst.h.postMock).not.toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledWith("/login", { replace: true });
  });

  it.each([500, 502, 503])(
    "stays logged in when refresh fails with %i",
    async (status) => {
      const { setupAuthInterceptor } = await loadApi();
      setupAuthInterceptor(navigate);
      const store = useBackingStore({
        cartiq_token: "expired-access",
        cartiq_refresh_token: "stored-refresh",
      });
      inst.h.postMock.mockRejectedValue({
        response: { status, data: {} },
      });

      await expect(inst.h.responseError(fail401())).rejects.toBeDefined();
      expect(store.cartiq_token).toBe("expired-access");
      expect(store.cartiq_refresh_token).toBe("stored-refresh");
      expect(navigate).not.toHaveBeenCalled();
      expect(inst.h.requestMock).not.toHaveBeenCalled();
    }
  );

  it("stays logged in when refresh hits a network error", async () => {
    const { setupAuthInterceptor } = await loadApi();
    setupAuthInterceptor(navigate);
    const store = useBackingStore({
      cartiq_token: "expired-access",
      cartiq_refresh_token: "stored-refresh",
    });
    inst.h.postMock.mockRejectedValue(new Error("socket hang up"));

    await expect(inst.h.responseError(fail401())).rejects.toBeDefined();
    expect(store.cartiq_token).toBe("expired-access");
    expect(store.cartiq_refresh_token).toBe("stored-refresh");
    expect(navigate).not.toHaveBeenCalled();
  });

  it("logs out when refresh is explicitly forbidden (403)", async () => {
    const { setupAuthInterceptor } = await loadApi();
    setupAuthInterceptor(navigate);
    const store = useBackingStore({
      cartiq_token: "expired-access",
      cartiq_refresh_token: "revoked-refresh",
    });
    inst.h.postMock.mockRejectedValue({
      response: { status: 403, data: {} },
    });

    await expect(inst.h.responseError(fail401())).rejects.toBeDefined();
    expect(store.cartiq_token).toBeUndefined();
    expect(navigate).toHaveBeenCalledWith("/login", { replace: true });
  });

  it("shares one refresh across concurrent 401s", async () => {
    const { setupAuthInterceptor } = await loadApi();
    setupAuthInterceptor(navigate);
    useBackingStore({
      cartiq_token: "expired-access",
      cartiq_refresh_token: "stored-refresh",
    });
    let resolveRefresh;
    inst.h.postMock.mockReturnValue(
      new Promise((resolve) => {
        resolveRefresh = resolve;
      })
    );

    const first = inst.h.responseError(fail401("/orders"));
    const second = inst.h.responseError(fail401("/inventory"));
    await Promise.resolve();
    expect(inst.h.postMock).toHaveBeenCalledTimes(1);

    resolveRefresh({ data: { token: "new-access" } });
    await Promise.all([first, second]);
    expect(inst.h.requestMock).toHaveBeenCalledTimes(2);
    expect(navigate).not.toHaveBeenCalled();
  });

  it("passes login 401s through without refresh or logout", async () => {
    const { setupAuthInterceptor } = await loadApi();
    setupAuthInterceptor(navigate);
    useBackingStore({ cartiq_token: "bad" });

    await expect(
      inst.h.responseError(fail401("/auth/login"))
    ).rejects.toBeDefined();
    expect(inst.h.postMock).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  });
});

describe("fetchApi error normalization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    inst.h.requestMock = vi.fn();
    inst.h.postMock = vi.fn();
  });

  it.each([
    [400, "Vendor is required"],
    [401, "Invalid credentials"],
    [403, "Forbidden"],
    [404, "Expense not found"],
    [409, "Duplicate record (already exists)."],
    [422, "Unprocessable order"],
    [500, "Internal server error"],
  ])("maps %i server errors to ApiError with server text", async (status, text) => {
    const { fetchApi, ApiError } = await loadApi();
    inst.h.requestMock.mockRejectedValue({
      response: { status, data: { error: text } },
      message: `Request failed with status code ${status}`,
    });

    const caught = await fetchApi({ method: "GET", url: "/x" }).catch((e) => e);

    expect(caught).toBeInstanceOf(ApiError);
    expect(caught.message).toBe(text);
    expect(caught.status).toBe(status);
    expect(caught.data).toEqual({ error: text });
  });

  it("falls back for network errors without a response", async () => {
    const { fetchApi, ApiError, getErrorMessage } = await loadApi();
    inst.h.requestMock.mockRejectedValue(new Error("socket hang up"));

    const caught = await fetchApi({ method: "GET", url: "/x" }).catch((e) => e);

    expect(caught).toBeInstanceOf(ApiError);
    expect(caught.message).toBe("socket hang up");
    expect(caught.status).toBeNull();
    expect(getErrorMessage(caught, "Fallback")).toBe("socket hang up");
    expect(getErrorMessage(new TypeError("boom"), "Fallback")).toBe("Fallback");
  });

  it("rethrows ApiError instances unchanged", async () => {
    const { fetchApi, ApiError } = await loadApi();
    const original = new ApiError("kept", { status: 400 });
    inst.h.requestMock.mockRejectedValue(original);

    const caught = await fetchApi({ method: "GET", url: "/x" }).catch((e) => e);

    expect(caught).toBe(original);
  });
});
