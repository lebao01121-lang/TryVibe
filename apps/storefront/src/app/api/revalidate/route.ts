import { revalidatePath, revalidateTag } from 'next/cache';
import { NextResponse, type NextRequest } from 'next/server';

interface RevalidateRequestBody {
  tags?: string[];
  paths?: string[];
}

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

  const tags = Array.isArray(body.tags)
    ? body.tags.filter((t): t is string => typeof t === 'string' && t.trim().length > 0)
    : [];
  const paths = Array.isArray(body.paths)
    ? body.paths.filter((p): p is string => typeof p === 'string' && p.startsWith('/'))
    : [];

  for (const tag of tags) {
    revalidateTag(tag);
  }
  for (const path of paths) {
    revalidatePath(path);
  }

  if (tags.length === 0 && paths.length === 0) {
    revalidateTag('storefront');
    revalidatePath('/');
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
