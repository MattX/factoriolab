import { readFile } from 'node:fs/promises';
import path from 'node:path';

import {
  HttpBackend,
  HttpClient,
  HttpEvent,
  HttpRequest,
  HttpResponse,
} from '@angular/common/http';
import {
  ApplicationRef,
  DOCUMENT,
  NgZone,
  ɵChangeDetectionScheduler as ChangeDetectionScheduler,
  ɵNoopNgZone as NoopNgZone,
  StaticProvider,
} from '@angular/core';
import { Router } from '@angular/router';
import { defer, Observable } from 'rxjs';

import { Confirm } from '~/components/confirm/confirm';
import { ConfirmData } from '~/components/confirm/confirm-data';

/** A failed local read, shaped like the HTTP failure the app would have seen. */
export class FilesystemHttpError extends Error {
  constructor(
    readonly status: number,
    readonly url: string,
    message: string,
  ) {
    super(message);
    this.name = 'FilesystemHttpError';
  }
}

/**
 * Serves the app's `data/<mod>/*.json` requests out of the local `public`
 * directory, so `SettingsStore`'s `httpResource` calls resolve with no network
 * and no `XMLHttpRequest`.
 */
export class FilesystemBackend implements HttpBackend {
  constructor(private readonly publicDir: string) {}

  handle(req: HttpRequest<unknown>): Observable<HttpEvent<unknown>> {
    return defer(async () => {
      const relative = req.url.replace(/^\.?\//, '');
      const root = path.resolve(this.publicDir);
      const target = path.resolve(root, relative);
      // Refuse to escape the data directory, whatever the request looks like.
      if (target !== root && !target.startsWith(root + path.sep))
        throw new FilesystemHttpError(
          403,
          req.url,
          `Refusing to read outside of the data directory: ${req.url}`,
        );

      let body: string;
      try {
        body = await readFile(target, 'utf8');
      } catch {
        throw new FilesystemHttpError(
          404,
          req.url,
          `No such data file: ${relative}`,
        );
      }

      return new HttpResponse({
        url: req.url,
        status: 200,
        statusText: 'OK',
        body: JSON.parse(body) as unknown,
      });
    });
  }
}

/** Migration warnings raised while parsing a URL, collected instead of shown. */
export class CollectedWarnings {
  readonly messages: string[] = [];

  take(): string[] {
    const result = [...this.messages];
    this.messages.length = 0;
    return result;
  }
}

/**
 * Replaces the CDK dialog-backed `Confirm`. `Migration` only uses it to report
 * warnings about outdated links, which the engine surfaces as plain text.
 */
class HeadlessConfirm implements Pick<Confirm, 'open'> {
  constructor(private readonly warnings: CollectedWarnings) {}

  open<T>(data: ConfirmData<T>): Observable<T | undefined> {
    this.warnings.messages.push(data.message);
    return new Observable<T | undefined>((subscriber) => {
      subscriber.next(undefined);
      subscriber.complete();
    });
  }
}

/** `ObjectivesStore` sets the browser tab title; there is no tab here. */
class HeadlessTitle {
  private value = '';

  getTitle(): string {
    return this.value;
  }

  setTitle(value: string): void {
    this.value = value;
  }
}

export function engineProviders(
  publicDir: string,
  warnings: CollectedWarnings,
  titleToken: unknown,
): StaticProvider[] {
  const backend = new FilesystemBackend(publicDir);
  return [
    { provide: DOCUMENT, useValue: globalThis.document },
    /**
     * `HttpClient` is built directly on the filesystem backend. The app has no
     * interceptors, so the usual `provideHttpClient` chain would only add an
     * `XMLHttpRequest`-based backend that cannot run here anyway.
     */
    { provide: HttpBackend, useValue: backend },
    { provide: HttpClient, useValue: new HttpClient(backend) },
    /**
     * `effect` and `resource` need a scheduler and a zone. In the browser these
     * come from `provideZonelessChangeDetection`, whose scheduler drives
     * `ApplicationRef.tick`. There is no application to tick here and the
     * engine flushes effects itself, so pending work only has to be absorbed.
     */
    {
      provide: ChangeDetectionScheduler,
      useValue: { notify: () => undefined, runningTick: false },
    },
    { provide: NgZone, useClass: NoopNgZone, deps: [] },
    /**
     * `RouterSync` reads `destroyed` to stop its subscription and calls `tick`
     * to kick off resource requests. Both are satisfied without an application.
     */
    {
      provide: ApplicationRef,
      useValue: {
        tick: () => undefined,
        destroyed: false,
        whenStable: () => Promise.resolve(),
      },
    },
    /**
     * `RouterSync` injects the router to push URL updates back into the address
     * bar. The engine asks it for the serialized params directly instead, so
     * navigation only has to be accepted and forgotten. Stubbing the token also
     * keeps the router's `PlatformLocation` and history plumbing out of Node.
     */
    {
      provide: Router,
      useValue: {
        url: '/',
        currentNavigation: () => null,
        navigate: () => Promise.resolve(true),
      },
    },
    { provide: Confirm, useValue: new HeadlessConfirm(warnings) },
    { provide: titleToken, useClass: HeadlessTitle, deps: [] },
  ];
}
