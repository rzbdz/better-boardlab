// Frontend tests (jsdom) get the browser pieces jsdom lacks and the mock boardd; Node tests need nothing.
if (typeof window !== 'undefined') await import('./frontend-setup.ts')
export {}
