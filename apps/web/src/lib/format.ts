// Template interpolation for i18n strings: `{name}` tokens are replaced from
// `vars`; tokens without a value stay literal so a missing variable is visible
// in the UI instead of silently vanishing.
export function formatTemplate(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{([A-Za-z0-9_]+)\}/g, (token, name: string) => {
    if (!Object.prototype.hasOwnProperty.call(vars, name)) return token;
    const value = vars[name];
    return value === undefined ? token : String(value);
  });
}
