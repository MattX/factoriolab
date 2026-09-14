/**
 * Angular's published packages are partially compiled, so the JIT linker has to
 * be loaded before any of them are imported. This module is the engine's single
 * entry point for that, and for the handful of browser globals the state layer
 * expects. Import it before anything under `~/`.
 *
 * The app only touches those globals in three places: `storedSignal`
 * (localStorage), `PreferencesStore`'s theming effect (document and
 * matchMedia), and `Icon`, which reads the root font size when its module
 * loads. Nothing here needs to behave like a real DOM, it only has to absorb
 * the writes.
 */
import '@angular/compiler';

interface ShimStyle {
  setProperty(name: string, value: string): void;
  removeProperty(name: string): void;
  getPropertyValue(name: string): string;
}

interface ShimElement {
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
  style: ShimStyle;
}

function createElement(): ShimElement {
  const attributes: Record<string, string> = {};
  const properties: Record<string, string> = {};
  return {
    setAttribute(name: string, value: string): void {
      attributes[name] = value;
    },
    removeAttribute(name: string): void {
      delete attributes[name];
    },
    style: {
      setProperty(name: string, value: string): void {
        properties[name] = value;
      },
      removeProperty(name: string): void {
        delete properties[name];
      },
      getPropertyValue(name: string): string {
        return properties[name] ?? '';
      },
    },
  };
}

function createStorage(): Storage {
  const map = new Map<string, string>();
  const storage = {
    get length(): number {
      return map.size;
    },
    key(index: number): string | null {
      return Array.from(map.keys())[index] ?? null;
    },
    getItem(key: string): string | null {
      return map.get(key) ?? null;
    },
    setItem(key: string, value: string): void {
      map.set(key, value);
    },
    removeItem(key: string): void {
      map.delete(key);
    },
    clear(): void {
      map.clear();
    },
  };
  return storage;
}

let installed = false;

export function installShims(): void {
  if (installed) return;
  installed = true;

  const global = globalThis as Record<string, unknown>;

  // `log` only reaches Google Analytics outside dev mode, but never throw.
  global['gtag'] ??= (): void => undefined;

  global['localStorage'] ??= createStorage();
  global['sessionStorage'] ??= createStorage();

  global['document'] ??= {
    documentElement: createElement(),
    head: createElement(),
    body: createElement(),
    title: '',
    createElement: (): ShimElement => createElement(),
    createTextNode: (): object => ({}),
    querySelector: (): null => null,
    querySelectorAll: (): never[] => [],
    // `TransferState` looks for a server-rendered state element.
    getElementById: (): null => null,
    getElementsByTagName: (): never[] => [],
    addEventListener: (): void => undefined,
    removeEventListener: (): void => undefined,
  };

  global['window'] ??= {
    document: global['document'],
    localStorage: global['localStorage'],
    matchMedia: (): object => ({
      matches: false,
      addEventListener: (): void => undefined,
      removeEventListener: (): void => undefined,
    }),
    // `Icon` reads the root font size at module load to compute a zoom factor.
    getComputedStyle: (): object => ({ fontSize: '16px' }),
    addEventListener: (): void => undefined,
    removeEventListener: (): void => undefined,
    location: { href: 'https://factoriolab.github.io/' },
  };
}

installShims();
