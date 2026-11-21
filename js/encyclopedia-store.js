/**
 * MLBB Items Encyclopedia - Data Connector & State Engine
 * Connects ./data/items.json to index.html and manages filters, caching, and saved builds.
 */

class EncyclopediaStore {
  constructor(options = {}) {
    this.jsonUrl = options.jsonUrl || "./data/items.json";
    this.storageKey = options.storageKey || "mlbb_encyclopedia_state_v1";
    this.fallbackData = options.fallbackData || null;

    this.state = {
      app: "MLBB Items Encyclopedia PWA",
      totalItems: 0,
      items: [],
      savedBuilds: [],
      filters: {
        category: "all",
        role: "all",
        search: "",
        maxCost: null
      },
      lastSyncedAt: null
    };

    this.listeners = new Set();
  }

  subscribe(callback) {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }

  emit() {
    const snapshot = this.getSnapshot();
    for (const listener of this.listeners) {
      listener(snapshot);
    }
  }

  getSnapshot() {
    return {
      ...this.state,
      filteredItems: this.getFilteredItems()
    };
  }

  async init() {
    const cached = this._readCache();
    if (cached && Array.isArray(cached.items) && cached.items.length > 0) {
      this.state.app = cached.app || this.state.app;
      this.state.items = cached.items;
      this.state.totalItems = cached.items.length;
      this.state.savedBuilds = Array.isArray(cached.savedBuilds) ? cached.savedBuilds : [];
      this.state.lastSyncedAt = cached.lastSyncedAt || null;
      this.emit();
    }

    try {
      const response = await fetch(this.jsonUrl, { cache: "no-store" });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: تعذر تحميل ملف البيانات`);
      }

      const data = await response.json();
      const rawItems = Array.isArray(data)
        ? data
        : Array.isArray(data?.items)
          ? data.items
          : null;

      if (!rawItems) {
        throw new Error("صيغة ملف JSON غير صالحة");
      }

      const fileBuilds = !Array.isArray(data) && Array.isArray(data?.savedBuilds)
        ? data.savedBuilds
        : [];

      const mergedBuilds = this._mergeBuilds(this.state.savedBuilds, fileBuilds);

      this.state.app = (!Array.isArray(data) && data?.app) || this.state.app;
      this.state.items = rawItems;
      this.state.totalItems = rawItems.length;
      this.state.savedBuilds = mergedBuilds;
      this.state.lastSyncedAt = new Date().toISOString();

      this._writeCache();
      this.emit();
      return this.getSnapshot();
    } catch (error) {
      const fallbackItems = Array.isArray(this.fallbackData)
        ? this.fallbackData
        : Array.isArray(this.fallbackData?.items)
          ? this.fallbackData.items
          : null;

      if (this.state.items.length === 0 && fallbackItems) {
        this.state.items = fallbackItems;
        this.state.totalItems = fallbackItems.length;
        this.state.savedBuilds = Array.isArray(this.fallbackData?.savedBuilds)
          ? this.fallbackData.savedBuilds
          : [];
        this.emit();
      }
      console.warn("EncyclopediaStore sync warning:", error.message);
      return this.getSnapshot();
    }
  }

  setFilters(partialFilters = {}) {
    this.state.filters = {
      ...this.state.filters,
      ...partialFilters
    };
    this.emit();
  }

  resetFilters() {
    this.state.filters = {
      category: "all",
      role: "all",
      search: "",
      maxCost: null
    };
    this.emit();
  }

  getFilteredItems() {
    const { category, role, search, maxCost } = this.state.filters;
    const query = (search || "").trim().toLowerCase();

    return this.state.items.filter((item) => {
      if (category !== "all" && item.category !== category) {
        return false;
      }

      if (role !== "all" && (!Array.isArray(item.roles) || !item.roles.includes(role))) {
        return false;
      }

      if (typeof maxCost === "number" && maxCost > 0 && Number(item.cost || 0) > maxCost) {
        return false;
      }

      if (query) {
        const haystack = [
          item.nameAr,
          item.nameEn,
          item.categoryAr,
          item.usefulFor,
          item.feature,
          ...(item.roles || [])
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();

        if (!haystack.includes(query)) {
          return false;
        }
      }

      return true;
    });
  }

  getItemById(id) {
    return this.state.items.find((item) => Number(item.id) === Number(id)) || null;
  }

  saveBuild({ id = null, name, role = "محاربين", itemIds = [], notes = "" }) {
    const cleanIds = (Array.isArray(itemIds) ? itemIds : [])
      .map(Number)
      .filter((itemId) => Boolean(this.getItemById(itemId)))
      .slice(0, 6);

    const totalCost = cleanIds.reduce((sum, itemId) => {
      const item = this.getItemById(itemId);
      return sum + (item ? Number(item.cost || 0) : 0);
    }, 0);

    if (id) {
      this.state.savedBuilds = this.state.savedBuilds.map((build) =>
        String(build.id) === String(id)
          ? {
              ...build,
              name: (name || build.name || "").trim() || "تشكيلة بدون اسم",
              role,
              itemIds: cleanIds,
              totalCost,
              notes,
              updatedAt: new Date().toISOString()
            }
          : build
      );
    } else {
      const newBuild = {
        id: `build_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        name: (name || "").trim() || `تشكيلة ${this.state.savedBuilds.length + 1}`,
        role,
        itemIds: cleanIds,
        totalCost,
        notes,
        createdAt: new Date().toISOString()
      };
      this.state.savedBuilds = [newBuild, ...this.state.savedBuilds];
    }

    this._writeCache();
    this.emit();
    return this.state.savedBuilds;
  }

  deleteBuild(buildId) {
    this.state.savedBuilds = this.state.savedBuilds.filter(
      (build) => String(build.id) !== String(buildId)
    );
    this._writeCache();
    this.emit();
    return this.state.savedBuilds;
  }

  exportJSON() {
    return JSON.stringify(
      {
        app: this.state.app,
        totalItems: this.state.items.length,
        items: this.state.items,
        savedBuilds: this.state.savedBuilds
      },
      null,
      2
    );
  }

  _mergeBuilds(localBuilds, fileBuilds) {
    const byId = new Map();
    for (const build of fileBuilds) {
      if (build && build.id) byId.set(String(build.id), build);
    }
    for (const build of localBuilds) {
      if (build && build.id) byId.set(String(build.id), build);
    }
    return Array.from(byId.values());
  }

  _readCache() {
    try {
      const raw = localStorage.getItem(this.storageKey);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }

  _writeCache() {
    try {
      localStorage.setItem(
        this.storageKey,
        JSON.stringify({
          app: this.state.app,
          totalItems: this.state.items.length,
          items: this.state.items,
          savedBuilds: this.state.savedBuilds,
          lastSyncedAt: this.state.lastSyncedAt
        })
      );
    } catch {
      // تجاهل أخطاء التخزين المحلي عند امتلائه أو منعه
    }
  }
}

window.EncyclopediaStore = EncyclopediaStore;
