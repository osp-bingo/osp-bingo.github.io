/**
 * 오상플레이 공용 서버 주소(api.ohsangplay.com)에서는 앱마다 경로 앞부분으로 나눈다.
 * 이 앱은 /bingo 아래를 받는다: https://api.ohsangplay.com/bingo/api/health → /api/health
 * workers.dev 주소로 들어오면 앞부분 없이 그대로 처리한다.
 */
export const PATH_PREFIX = '/bingo';

export function stripPathPrefix(pathname: string): string {
  if (pathname === PATH_PREFIX) return '/';
  if (pathname.startsWith(`${PATH_PREFIX}/`)) return pathname.slice(PATH_PREFIX.length);
  return pathname;
}

/** 경로 앞부분을 뗀 요청. 바꿀 게 없으면 그대로. */
export function withoutPrefix(request: Request): Request {
  const url = new URL(request.url);
  const path = stripPathPrefix(url.pathname);
  if (path === url.pathname) return request;
  url.pathname = path;
  return new Request(url.toString(), request);
}
