'''
This file contains the models and inference code for translating and romanization
'''
from transformers import MarianMTModel, MarianTokenizer
import torch
tokenizer, model, current_model = None, None, None

# model init
def init(translate_language_code: str, target_language_code: str = "en") -> None:
    '''
    Function that initializes a translation model with the correct language parameters for translation

    Args:
        translate_language_code: String input of the language to translate from (e.g. "en", "ko")
        target_language_code: String output of the language to translate to (e.g. "en", "ko")
    '''
    global tokenizer, model, current_model
    model_name = f"Helsinki-NLP/opus-mt-{translate_language_code}-{target_language_code}"

    if current_model == model_name:
        return

    tokenizer = MarianTokenizer.from_pretrained(model_name)
    model = MarianMTModel.from_pretrained(model_name, device_map="auto")
    model.eval()

    current_model = model

# translate
def translate(text: str) -> str:
    '''
    Function to translate a given language string to English via open-source encoder-decoder transformer model MarianMT
    We use MarianMT for lightweight inference (extremely high-quality translation is not needed too strictly)

    Args:
        text: String text to translate
    Returns:
        Translated text string
    ''' 
    global tokenizer, model

    if tokenizer is None or model is None:
        raise RuntimeError("Need to init a translation model first")

    # tokenize, translate, decode results
    inputs = tokenizer(text, return_tensors="pt", padding=True, truncation=True).to(model.device)
        
    with torch.inference_mode():
        outputs = model.generate(**inputs)
    
    translated = tokenizer.batch_decode(outputs, skip_special_tokens=True)

    return translated[0].strip()

def romanize(text: str, translate_language_code: str) -> str:
    '''
    Function to romanize a given language string (if applicable) 
    Note romanization is language-specific. For now, support only East Asian languages ("ko", "ja", "zh")

    Args: 
        text: String input of the text to romanize
        translate_language_code: String input of the language to romanize from (e.g. "en", "ko")
    Returns:
        Romanized text string
    '''
    if translate_language_code == "ko":
        from korean_romanizer.romanizer import Romanizer
        r = Romanizer(text)
        return r.romanize()
    
    elif translate_language_code == "ja":
        # jp to romaji
        import cutlet
        romanized = cutlet.Cutlet().romaji(text)
        return romanized

    elif translate_language_code == "zh":
        from pypinyin import pinyin, Style
        result = pinyin(text, style=Style.TONE, v_to_u=True, errors='ignore')
        result = " ".join([item[0] for item in result])
        return result

    else:
        return ""

if __name__ == "__main__":
    print(romanize("미칠듯 사랑했던 기억이\n 추억들이 너를 찾고 있지만", "ko"))
    print(romanize("誰說太陽會找到月亮\n 別人有的愛 我們不可能模仿", "zh"))
    print(romanize("愛に傷ついた あの日からずっと\n 昼と夜が逆の 暮らしを続けて\n はやりのDiscoで 踊り明かすうちに", "ja"))

    init("ko", "en")
    print(translate("미칠듯 사랑했던 기억이\n 추억들이 너를 찾고 있지만"))

    init("ja", "en")
    print(translate("愛に傷ついた あの日からずっと\n 昼と夜が逆の 暮らしを続けて\n はやりのDiscoで 踊り明かすうちに"))

    init("zh", "en")
    print(translate("誰說太陽會找到月亮\n 別人有的愛 我們不可能模仿"))
