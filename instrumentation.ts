import * as Sentry from '@sentry/nextjs'
import pkg from './package.json'

export function register() {
  Sentry.init({
    dsn:     process.env.NEXT_PUBLIC_SENTRY_DSN,
    release: `sunpos-kakao@${pkg.version}`,
  })
}

export const onRequestError = Sentry.captureRequestError
