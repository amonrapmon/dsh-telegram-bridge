// Preloaded only by the CI Harness smoke test. No network request to Telegram.
import { appendFileSync } from 'node:fs';

const destination = process.env.MOCK_TELEGRAM_TRACE;
if (!destination) throw new Error('MOCK_TELEGRAM_TRACE required');
const nativeFetch = globalThis.fetch;
let delivered = false;
const emit = name => appendFileSync(destination, name + '\n');

globalThis.fetch = async function fakeTelegramFetch(url, options) {
  const target = String(url);
  if (!target.startsWith('https://api.telegram.org/bot')) {
    return nativeFetch(url, options);
  }
  const endpoint = target.substring(target.lastIndexOf('/') + 1);
  const params = JSON.parse(options?.body || '{}');
  if (endpoint === 'getMe') {
    emit('getMe');
    return Response.json({ ok:true, result:{ id:987654321, is_bot:true, first_name:'Test', username:'HarnessSmokeBot' }});
  }
  if (endpoint === 'setMyCommands') {
    emit('setMyCommands');
    return Response.json({ok:true,result:true});
  }
  if (endpoint === 'getUpdates') {
    if (!delivered) {
      delivered = true;
      emit('getUpdates:2');
      return Response.json({ok:true,result:[
        {
          update_id:100,
          message:{ message_id:200, date:1760000000, chat:{id:777777,type:'private'},
            from:{id:777777,is_bot:false,first_name:'Mock'},text:'/start' },
        },
        {
          update_id:101,
          message:{ message_id:201, date:1760000001, chat:{id:777777,type:'private'},
            from:{id:777777,is_bot:false,first_name:'Mock'},text:'/new' },
        },
      ]});
    }
    // Real Telegram long-poll waits for new updates. Avoid hot-looping on CI.
    await new Promise(resolve => setTimeout(resolve, 250));
    return Response.json({ok:true,result:[]});
  }
  if (endpoint === 'sendMessage') {
    if (params.chat_id !== 777777) throw new Error('Bridge sent to an unexpected chat');
    if (params.text.includes('Each Telegram topic keeps its own conversation')) {
      emit('sendMessage:start');
    } else if (params.text.includes('Started a new conversation in this topic')) {
      emit('sendMessage:new-success');
    } else if (params.text.includes('Could not create a Harness conversation')) {
      emit('sendMessage:new-failed');
    } else {
      throw new Error('Bridge sent an unexpected response');
    }
    return Response.json({ok:true,result:{message_id:201}});
  }
  throw new Error('Unexpected Telegram call ' + endpoint);
};
