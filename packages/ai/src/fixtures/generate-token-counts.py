import json
from pathlib import Path
import tiktoken

path = Path(__file__).with_name('token-counts.json')
texts = {
    'english': 'Please reset my password. The confirmation email never arrived.',
    'chinese': '请重置我的密码。我没有收到确认邮件。',
    'japanese': 'パスワードをリセットしてください。確認メールが届きません。',
    'emoji': '👩🏽‍💻🔐🚀🏳️‍🌈🙂',
    'code': 'const reset = async (id: string) => {\n  return await db.users.find({ id });\n};',
}
encodings = ['cl100k_base', 'o200k_base']
assert tiktoken.__version__ == '0.12.0'
fixture = {
    'source': 'https://github.com/openai/tiktoken/tree/0.12.0',
    'version': tiktoken.__version__,
    'cases': [dict(name=name, text=text, counts={enc: len(tiktoken.get_encoding(enc).encode_ordinary(text)) for enc in encodings}) for name, text in texts.items()],
}
path.write_text(json.dumps(fixture, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
