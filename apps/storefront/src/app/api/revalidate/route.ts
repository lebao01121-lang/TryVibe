import { revalidatePath, revalidateTag } from 'next/cache';
import { NextResponse, type NextRequest } from 'next/server';
import { invalidateStorefrontMemoryCache } from '@/lib/bootstrap';

interface RevalidateRequestBody {
  tags?: string[];
  tag?: string;
  paths?: string[];
  path?: string;
  slug?: string;
  slugs?: string[];
}

const DEFAULT_REVALIDATE_TAGS = [
  'storefront',
  'products',
  'rack',
  'bootstrap',
  'occasions',
  'seasons',
] as const;

const DEFAULT_REVALIDATE_PATHS = ['/', '/bo-suu-tap'] as const;

export async function POST(request: NextRequest) {
  const expectedSecret =
    process.env.REVALIDATE_SECRET || 'Atelier_Isr_Revalidate_2026!';
  const providedSecret = request.headers.get('x-revalidate-secret');

  if (!providedSecret || providedSecret !== expectedSecret) {
    return NextResponse.json(
      {
        revalidated: false,
        error: 'UNAUTHORIZED_REVALIDATE_SECRET',
      },
      { status: 401 },
    );
  }

  let body: RevalidateRequestBody = {};
  try {
    body = (await request.json()) as RevalidateRequestBody;
  } catch {
    body = {};
  }

  const tagSet = new Set<string>();
  const pathSet = new Set<string>();

  if (Array.isArray(body.tags)) {
    for (const t of body.tags) {
      if (typeof t === 'string' && t.trim().length > 0) {
        tagSet.add(t.trim());
      }
    }
  }
  if (typeof body.tag === 'string' && body.tag.trim().length > 0) {
    tagSet.add(body.tag.trim());
  }

  if (Array.isArray(body.paths)) {
    for (const p of body.paths) {
      if (typeof p === 'string' && p.trim().startsWith('/')) {
        pathSet.add(p.trim());
      }
    }
  }
  if (typeof body.path === 'string' && body.path.trim().startsWith('/')) {
    pathSet.add(body.path.trim());
  }

  const slugList: string[] = [];
  if (typeof body.slug === 'string' && body.slug.trim().length > 0) {
    slugList.push(body.slug.trim());
  }
  if (Array.isArray(body.slugs)) {
    for (const s of body.slugs) {
      if (typeof s === 'string' && s.trim().length > 0) {
        slugList.push(s.trim());
      }
    }
  }
  for (const slug of slugList) {
    const cleanSlug = slug.replace(/^\/+/, '');
    tagSet.add(`product:${cleanSlug}`);
    pathSet.add(`/san-pham/${cleanSlug}`);
  }

  const isDefaultRevalidate = tagSet.size === 0 && pathSet.size === 0;
  if (isDefaultRevalidate) {
    for (const tag of DEFAULT_REVALIDATE_TAGS) {
      tagSet.add(tag);
    }
    for (const path of DEFAULT_REVALIDATE_PATHS) {
      pathSet.add(path);
    }
  }

  const tags = Array.from(tagSet);
  const paths = Array.from(pathSet);

  invalidateStorefrontMemoryCache(tags);
  for (const tag of tags) {
    revalidateTag(tag);
  }
  for (const path of paths) {
    if (path.includes('[')) {
      revalidatePath(path, 'page');
    } else {
      revalidatePath(path);
    }
  }

  if (
    isDefaultRevalidate ||
    tagSet.has('products') ||
    tagSet.has('storefront')
  ) {
    revalidatePath('/bo-suu-tap/[[...slug]]', 'page');
    revalidatePath('/san-pham/[slug]', 'page');
  }

  return NextResponse.json(
    {
      revalidated: true,
      tags,
      paths,
      timestamp: new Date().toISOString(),
    },
    { status: 200 },
  );
}
