export const compactNumber = (value: number) =>
  value >= 10000
    ? `${(value / 10000).toFixed(1)}万`
    : value.toLocaleString("zh-CN");
export const remaining = (timestamp: string, now: number) => {
  const seconds = Math.max(0, Math.ceil((Date.parse(timestamp) - now) / 1000));
  return seconds >= 60
    ? `${Math.floor(seconds / 60)}分${seconds % 60}秒`
    : `${seconds}秒`;
};
