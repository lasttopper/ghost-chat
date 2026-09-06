/* ImgBB client-side upload config.
 *
 * Why client-side: ImgBB rejects uploads coming from cloud/datacenter IPs
 * (error 103 "forbidden" — verified from two server networks) but accepts
 * uploads from ordinary user devices, and their API allows cross-origin
 * requests (Access-Control-Allow-Origin: *). So the app uploads straight
 * from the device; the chat server still only accepts i.ibb.co URLs in
 * messages, and a server-side proxy remains as a fallback.
 *
 * NOTE: this key is public by nature (it ships with the app). If it is ever
 * abused, regenerate it at https://api.imgbb.com and update this file and
 * the IMGBB_API_KEY env var on the server. */
window.IMGBB_CONFIG = {
  apiUrl: 'https://api.imgbb.com/1/upload',
  apiKey: '56bf5f1d16a21fd88095198ba5412ddf',
};
