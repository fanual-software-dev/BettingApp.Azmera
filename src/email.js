import nodemailer from 'nodemailer';
export const ownerInbox='asfawfanual2003@gmail.com';
export function smtpTransport(settings) {
  return settings?.host&&settings.user&&settings.pass&&settings.from ? nodemailer.createTransport({host:settings.host,port:settings.port,secure:settings.port===465,requireTLS:true,auth:{user:settings.user,pass:settings.pass},connectionTimeout:10000,greetingTimeout:10000,socketTimeout:20000,disableFileAccess:true,disableUrlAccess:true}) : null;
}
