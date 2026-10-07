import * as Sentry from '@sentry/nextjs'
import pkg from './package.json'

Sentry.init({
  dsn:     process.env.NEXT_PUBLIC_SENTRY_DSN,
  release: `sunpos-kakao@${pkg.version}`,
})
