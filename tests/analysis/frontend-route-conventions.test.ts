import { describe, expect, it } from 'vitest';
import {
  isInterceptingRoutePair,
  isNextRouteEntryFile,
  nextRouteIdentity,
} from '../../src/analysis/frontend-route-conventions.js';

describe('frontend route conventions', () => {
  it('recognizes Next.js app-router entry files by convention name', () => {
    expect(isNextRouteEntryFile('src/app/(dashboard)/media/[id]/page.tsx')).toBe(true);
    expect(isNextRouteEntryFile('app/layout.tsx')).toBe(true);
    expect(isNextRouteEntryFile('src/app/api/items/route.ts')).toBe(true);
    expect(isNextRouteEntryFile('src/app/(dashboard)/media/components/MediaCard.tsx')).toBe(false);
    expect(isNextRouteEntryFile('src/components/page.tsx')).toBe(false);
    expect(isNextRouteEntryFile('src/app/page.test.tsx')).toBe(false);
  });

  it('resolves route groups, parallel slots, and intercept markers to one route', () => {
    expect(nextRouteIdentity('src/app/(authenticated)/(dashboard)/media/[id]/page.tsx')).toEqual({
      route: ['media', '[id]'],
      entry: 'page',
      intercepting: false,
    });
    expect(nextRouteIdentity('src/app/(authenticated)/(dashboard)/@modal/(.)media/[id]/page.tsx')).toEqual({
      route: ['media', '[id]'],
      entry: 'page',
      intercepting: true,
    });
    expect(nextRouteIdentity('app/feed/@modal/(..)photo/[id]/page.tsx')).toEqual({
      route: ['photo', '[id]'],
      entry: 'page',
      intercepting: true,
    });
    expect(nextRouteIdentity('app/a/b/@modal/(..)(..)photo/page.tsx')).toEqual({
      route: ['photo'],
      entry: 'page',
      intercepting: true,
    });
    expect(nextRouteIdentity('app/a/b/c/(...)photo/page.tsx')).toEqual({
      route: ['photo'],
      entry: 'page',
      intercepting: true,
    });
  });

  it('pairs an intercepting route only with the route it intercepts', () => {
    const target = 'src/app/(authenticated)/(dashboard)/media/[id]/page.tsx';
    const intercept = 'src/app/(authenticated)/(dashboard)/@modal/(.)media/[id]/page.tsx';
    expect(isInterceptingRoutePair(intercept, target)).toBe(true);
    expect(isInterceptingRoutePair(target, intercept)).toBe(true);
    expect(isInterceptingRoutePair(intercept, 'src/app/(authenticated)/(dashboard)/media/page.tsx')).toBe(false);
    expect(isInterceptingRoutePair(target, 'src/app/(authenticated)/(dashboard)/campaigns/[id]/page.tsx')).toBe(false);
    expect(
      isInterceptingRoutePair(intercept, 'src/app/(authenticated)/(dashboard)/@modal/(.)media/[id]/layout.tsx'),
    ).toBe(false);
  });
});
