export function depositBonus(amount) {
  const rateBps=amount<=99900?1000:1500;
  return {rateBps,amount:Math.floor(amount*rateBps/10000)};
}
