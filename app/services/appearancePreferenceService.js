export const DEFAULT_APPEARANCE_PREFERENCE = "system";
export const APPEARANCE_PREFERENCES = Object.freeze([
  DEFAULT_APPEARANCE_PREFERENCE,
  "light",
  "dark",
]);

const APPEARANCE_PREFERENCE_SET = new Set(APPEARANCE_PREFERENCES);

export function isAppearancePreference(value) {
  return (
    typeof value === "string" &&
    APPEARANCE_PREFERENCE_SET.has(value)
  );
}

function assertAppearancePreference(value) {
  if (!isAppearancePreference(value)) {
    throw new TypeError(
      "appearance must be exactly system, light, or dark",
    );
  }
  return value;
}

function assertUserId(value) {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError("userId is required");
  }
  return value;
}

export class AppearancePreferenceService {
  #repository;

  constructor({ repository } = {}) {
    if (
      typeof repository?.getUserAppearancePreference !== "function" ||
      typeof repository?.updateUserAppearancePreference !== "function"
    ) {
      throw new TypeError(
        "An appearance preference repository is required.",
      );
    }
    this.#repository = repository;
  }

  async getAppearancePreference(userId) {
    const appearance = await this.#repository.getUserAppearancePreference(
      assertUserId(userId),
    );
    return assertAppearancePreference(appearance);
  }

  async setAppearancePreference(userId, appearance) {
    const saved = await this.#repository.updateUserAppearancePreference(
      assertUserId(userId),
      assertAppearancePreference(appearance),
    );
    return assertAppearancePreference(saved);
  }
}

export class DemoAppearancePreferenceService {
  #preferences = new Map();

  async getAppearancePreference(userId) {
    const id = assertUserId(userId);
    return this.#preferences.get(id) ?? DEFAULT_APPEARANCE_PREFERENCE;
  }

  async setAppearancePreference(userId, appearance) {
    const id = assertUserId(userId);
    const preference = assertAppearancePreference(appearance);
    this.#preferences.set(id, preference);
    return preference;
  }
}

export function createAppearancePreferenceService({ repository } = {}) {
  return new AppearancePreferenceService({ repository });
}

export function createDemoAppearancePreferenceService() {
  return new DemoAppearancePreferenceService();
}

export function createAppearancePreferenceResolver({
  appearancePreferenceService = null,
} = {}) {
  return async function resolveAppearancePreference(
    request,
    response,
    next,
  ) {
    const isSignedIn = Boolean(request.user?.id);
    const sessionPreference = request.session?.appearancePreference;
    const fallback =
      isSignedIn && isAppearancePreference(sessionPreference)
        ? sessionPreference
        : DEFAULT_APPEARANCE_PREFERENCE;
    response.locals.appearancePreference = fallback;

    if (
      request.method !== "GET" ||
      request.path.startsWith("/api/") ||
      !isSignedIn ||
      !request.accepts("html") ||
      typeof appearancePreferenceService?.getAppearancePreference !==
        "function"
    ) {
      next();
      return;
    }

    try {
      const appearance = assertAppearancePreference(
        await appearancePreferenceService.getAppearancePreference(
          request.user.id,
        ),
      );
      response.locals.appearancePreference = appearance;
      if (request.session) {
        request.session.appearancePreference = appearance;
      }
    } catch {
      response.locals.appearancePreference = fallback;
    }
    next();
  };
}
