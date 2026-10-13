// Preloaded only by the CI Harness smoke test. No network request to Telegram.
import { appendFileSync } from 'node:fs';

const destination = process.env.MOCK_TELEGRAM_TRACE;
if (!destination) throw new Error('MOCK_TELEGRAM_TRACE required');
const nativeFetch = globalThis.fetch;
let delivered = false;
let approvalButton;
let approvalCardId;
let stage = 0;
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
    if (!params.allowed_updates?.includes('my_chat_member')
      || !params.allowed_updates?.includes('callback_query')) {
      throw new Error('Bridge did not subscribe to group membership and approval updates');
    }
    if (!delivered) {
      delivered = true;
      emit('getUpdates:membership');
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
        {
          update_id:102,
          my_chat_member:{
            chat:{id:-100900,type:'supergroup',title:'CI Project',is_forum:true},
            from:{id:777777,is_bot:false},
            old_chat_member:{status:'left',user:{id:987654321}},
            new_chat_member:{status:'member',user:{id:987654321}},
          },
        },
      ]});
    }
    if (stage === 0 && approvalButton) {
      stage=1;
      emit('getUpdates:approval');
      return Response.json({ok:true,result:[{
        update_id:103, callback_query:{
          id:'callback-103', from:{id:777777,is_bot:false},
          message:{message_id:approvalCardId,chat:{id:777777,type:'private'}},
          data:approvalButton,
        },
      }]});
    }
    if (stage === 1) {
      stage=2;
      emit('getUpdates:group-command');
      return Response.json({ok:true,result:[{
        update_id:104, message:{
          message_id:204,date:1760000002,from:{id:777777,is_bot:false},
          chat:{id:-100900,type:'supergroup',title:'CI Project',is_forum:true},
          message_thread_id:77,text:'/new',
        },
      }]});
    }
    // Real Telegram long-poll waits for new updates. Avoid hot-looping on CI.
    await new Promise(resolve => setTimeout(resolve, 250));
    return Response.json({ok:true,result:[]});
  }
  if (endpoint === 'sendMessage') {
    if (params.reply_markup?.inline_keyboard) {
      if (params.parse_mode !== 'HTML'
        || !params.text.includes('\n\n')
        || params.text.includes('\\n')
        || !params.text.includes('<b>Группа:</b>')) {
        throw new Error('Approval card formatting is not valid Telegram HTML');
      }
      if (params.chat_id !== 777777 || approvalButton) {
        throw new Error('Group access request leaked or duplicated');
      }
      approvalButton=params.reply_markup.inline_keyboard[0][0].callback_data;
      approvalCardId=777;
      emit('sendMessage:group-request');
      return Response.json({ok:true,result:{message_id:approvalCardId}});
    }
    if (params.chat_id === -100900) {
      if (params.message_thread_id !== 77 ||
        !params.text.includes('Started a new conversation in this topic')) {
        throw new Error('Wrong group topic response');
      }
      emit('sendMessage:group-new-success');
    } else if (params.chat_id === 777777) {
      if (params.text.includes('Each Telegram topic keeps its own conversation')) {
        emit('sendMessage:start');
      } else if (params.text.includes('Started a new conversation in this topic')) {
        emit('sendMessage:new-success');
      } else if (params.text.includes('Could not create a Harness conversation')) {
        emit('sendMessage:new-failed');
      } else {
        throw new Error('Bridge sent an unexpected private response');
      }
    } else throw new Error('Bridge sent to an unexpected chat');
    return Response.json({ok:true,result:{message_id:201}});
  }
  if (endpoint === 'answerCallbackQuery') {
    if (params.callback_query_id !== 'callback-103') throw new Error('Incorrect approval callback');
    emit('answerCallbackQuery:ok');
    return Response.json({ok:true,result:true});
  }
  if (endpoint === 'editMessageText') {
    if (params.chat_id !== 777777 || params.message_id !== approvalCardId
      || !params.text.includes('Доступ разрешён')
      || params.parse_mode !== 'HTML' || params.text.includes('\\n')) {
      throw new Error('Owner approval confirmation card incorrect');
    }
    emit('editMessageText:approved');
    return Response.json({ok:true,result:true});
  }
  throw new Error('Unexpected Telegram call ' + endpoint);
};
