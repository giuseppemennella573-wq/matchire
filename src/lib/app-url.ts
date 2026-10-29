/** Public address of the app, for links in emails. Set APP_URL in production. */
export const appUrl = () => (process.env.APP_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/$/, "");
