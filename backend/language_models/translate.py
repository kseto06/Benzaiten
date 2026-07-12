"""
This file contains the models and inference code for translating and romanization
"""

import json
import os
from typing import List, Dict, Tuple

from huggingface_hub import HfApi
from transformers import AutoModelForSeq2SeqLM, AutoTokenizer
import torch

tokenizer, model, current_model, translation_steps = None, None, None, []


def _normalize_language_code(language_code: str) -> str:
    return (language_code or "").strip().lower()


def _load_translation_step(model_name: str):
    step_tokenizer = AutoTokenizer.from_pretrained(model_name)
    step_model = AutoModelForSeq2SeqLM.from_pretrained(model_name).to(
        "cuda" if torch.cuda.is_available() else "cpu"
    )
    step_model.eval()
    return model_name, step_tokenizer, step_model


def _load_env_model_overrides() -> Dict[Tuple[str, str], List[str]]:
    raw_overrides = (
        os.environ.get("TRANSLATION_MODEL_OVERRIDES")
        or os.environ.get("HF_TRANSLATION_MODEL_OVERRIDES")
        or ""
    ).strip()
    if not raw_overrides:
        return {}

    try:
        parsed = json.loads(raw_overrides)
    except json.JSONDecodeError as error:
        raise ValueError(
            "TRANSLATION_MODEL_OVERRIDES must be JSON like "
            '{"ko-zh": ["owner/model-id"]}'
        ) from error

    overrides = {}
    for language_pair, model_names in parsed.items():
        if "-" not in language_pair:
            raise ValueError(
                "TRANSLATION_MODEL_OVERRIDES keys must be language pairs like ko-zh"
            )
        source_language_code, target_language_code = language_pair.split("-", 1)
        if isinstance(model_names, str):
            model_names = [model_names]
        overrides[
            (
                _normalize_language_code(source_language_code),
                _normalize_language_code(target_language_code),
            )
        ] = [str(model_name).strip() for model_name in model_names if model_name]

    return overrides


def _model_id_score(
    model_id: str, source_language_code: str, target_language_code: str
) -> Tuple[int, str]:
    """
    Function to score a Hugging Face model ID based on
    how well it matches the desired source and target languages.

    Args:
        model_id: The Hugging Face model ID to score.
        source_language_code: The source language code (e.g., "en", "ko").
        target_language_code: The target language code (e.g., "en", "ko").

    Returns:
        A tuple containing the score (lower is better) and the normalized model ID.
    """
    normalized_model_id = model_id.lower()

    best_score = 100
    direct_patterns = [
        f"opus-mt-{source_language_code}-{target_language_code}",
        f"{source_language_code}-{target_language_code}",
        f"{source_language_code}_{target_language_code}",
        f"{source_language_code}2{target_language_code}",
        f"{source_language_code}-to-{target_language_code}",
    ]
    for pattern in direct_patterns:
        if normalized_model_id.endswith("/" + pattern):
            best_score = min(best_score, 0)
        elif pattern in normalized_model_id:
            best_score = min(best_score, 5)

    if "opus-mt" in normalized_model_id:
        best_score = min(best_score, 20)
    if "translation" in normalized_model_id or "translate" in normalized_model_id:
        best_score = min(best_score, 30)

    return best_score, normalized_model_id


def _search_huggingface_translation_models(
    source_language_code: str,
    target_language_code: str,
    *,
    limit: int = 12,
) -> List[str]:
    """
    Function to search for best matches of translation models on Hugging Face Hub,
    based on source and target language codes

    Args:
        source_language_code: The source language code (e.g., "en", "ko").
        target_language_code: The target language code (e.g., "en", "ko").
        limit: The maximum number of models to return.

    Returns:
        A list of model IDs that match the source and target languages.
    """
    api = HfApi()
    source_language_code = _normalize_language_code(source_language_code)
    target_language_code = _normalize_language_code(target_language_code)
    searches = [
        f"opus-mt-{source_language_code}-{target_language_code}",
        f"{source_language_code}-{target_language_code} translation",
        f"{source_language_code} {target_language_code} translation",
    ]

    model_ids = []
    seen_model_ids = set()
    for search in searches:
        try:
            models = api.list_models(
                search=search,
                pipeline_tag="translation",
                sort="downloads",
                limit=limit,
            )
            for model_info in models:
                model_id = getattr(model_info, "modelId", None)
                if not model_id or model_id in seen_model_ids:
                    continue
                if getattr(model_info, "gated", False):
                    continue
                seen_model_ids.add(model_id)
                model_ids.append(model_id)
        except Exception:
            continue

    model_ids.sort(
        key=lambda model_id: _model_id_score(
            model_id, source_language_code, target_language_code
        )
    )
    return model_ids


def _translation_model_candidates(
    source_language_code: str,
    target_language_code: str,
    *,
    include_hub_search: bool = False,
) -> List[str]:
    """
    Function to get a list of candidate translation models for the given source and target languages.

    Args:
        source_language_code: The source language code (e.g., "en", "ko").
        target_language_code: The target language code (e.g., "en", "ko").
        include_hub_search: Whether to include models found via Hugging Face Hub search.

    Returns:
        A list of candidate model IDs that can be used for translation
    """
    env_overrides = _load_env_model_overrides()
    language_pair = (
        _normalize_language_code(source_language_code),
        _normalize_language_code(target_language_code),
    )

    candidates = list(env_overrides.get(language_pair, []))

    if include_hub_search:
        candidates.extend(
            _search_huggingface_translation_models(
                source_language_code, target_language_code
            )
        )

    deduped_candidates = []
    seen_candidates = set()
    for candidate in candidates:
        candidate = candidate.strip()
        if not candidate or candidate in seen_candidates:
            continue
        seen_candidates.add(candidate)
        deduped_candidates.append(candidate)

    return deduped_candidates


def _load_first_available_translation_step(
    source_language_code: str, target_language_code: str
) -> Tuple[str, AutoTokenizer, AutoModelForSeq2SeqLM]:
    """
    Function to load the first available translation model for the given source and target languages.

    Args:
        source_language_code: The source language code (e.g., "en", "ko").
        target_language_code: The target language code (e.g., "en", "ko").

    Returns:
        A tuple containing the loaded model name, tokenizer, and model
    """
    errors = []
    deterministic_candidates = _translation_model_candidates(
        source_language_code, target_language_code, include_hub_search=False
    )

    for model_name in deterministic_candidates:
        try:
            return _load_translation_step(model_name)
        except Exception as error:
            errors.append(f"{model_name}: {error}")

    search_candidates = [
        candidate
        for candidate in _translation_model_candidates(
            source_language_code, target_language_code, include_hub_search=True
        )
        if candidate not in deterministic_candidates
    ]

    for model_name in search_candidates:
        try:
            return _load_translation_step(model_name)
        except Exception as error:
            errors.append(f"{model_name}: {error}")

    raise RuntimeError(
        "No compatible Hugging Face translation model could be loaded for "
        f"{source_language_code}->{target_language_code}. Tried: "
        + "; ".join(errors[:8])
    )


# model init
def init(translate_language_code: str, target_language_code: str = "en") -> None:
    """
    Function that initializes a translation model with the correct language parameters for translation

    Args:
        translate_language_code: String input of the language to translate from (e.g. "en", "ko")
        target_language_code: String output of the language to translate to (e.g. "en", "ko")
    """
    global tokenizer, model, current_model, translation_steps
    translate_language_code = _normalize_language_code(translate_language_code)
    target_language_code = _normalize_language_code(target_language_code) or "en"

    if translate_language_code == target_language_code:
        current_model = f"identity:{translate_language_code}->{target_language_code}"
        tokenizer = None
        model = None
        translation_steps = []
        return

    model_name = f"{translate_language_code}->{target_language_code}"

    if current_model == model_name or (
        current_model is not None and current_model.startswith(f"{model_name}:")
    ):
        return

    try:
        loaded_model_name, tokenizer, model = _load_first_available_translation_step(
            translate_language_code, target_language_code
        )
        translation_steps = [(tokenizer, model)]
        current_model = f"{model_name}:{loaded_model_name}"
        return
    except Exception as direct_error:
        if translate_language_code == "en" or target_language_code == "en":
            raise RuntimeError(
                f"Failed to load translation model for {model_name}"
            ) from direct_error

        pivot_model_name = " -> ".join(
            [
                f"{translate_language_code}->en",
                f"en->{target_language_code}",
            ]
        )

        if current_model == pivot_model_name or (
            current_model is not None
            and current_model.startswith(f"{pivot_model_name}:")
        ):
            return

        try:
            pivot_model_name_1, pivot_tokenizer_1, pivot_model_1 = (
                _load_first_available_translation_step(translate_language_code, "en")
            )
            pivot_model_name_2, pivot_tokenizer_2, pivot_model_2 = (
                _load_first_available_translation_step("en", target_language_code)
            )
        except Exception as pivot_error:
            raise RuntimeError(
                "Failed to load direct or English-pivot translation models "
                f"for {translate_language_code}->{target_language_code}; "
                f"pivot path was {pivot_model_name}"
            ) from pivot_error

        tokenizer = pivot_tokenizer_1
        model = pivot_model_1
        translation_steps = [
            (pivot_tokenizer_1, pivot_model_1),
            (pivot_tokenizer_2, pivot_model_2),
        ]
        current_model = f"{pivot_model_name}:{pivot_model_name_1}->{pivot_model_name_2}"


# translate
def translate(text: str) -> str:
    """
    Function to translate a given language string to English via open-source encoder-decoder transformer model MarianMT
    We use MarianMT for lightweight inference (extremely high-quality translation is not needed too strictly)

    Args:
        text: String text to translate
    Returns:
        Translated text string
    """
    global tokenizer, model, translation_steps

    if current_model is not None and current_model.startswith("identity:"):
        return text.strip()

    if not translation_steps:
        raise RuntimeError("Need to init a translation model first")

    translated_text = text.strip()
    for step_tokenizer, step_model in translation_steps:
        # tokenize, translate, decode results
        inputs = step_tokenizer(
            translated_text, return_tensors="pt", padding=True, truncation=True
        ).to(step_model.device)

        with torch.inference_mode():
            outputs = step_model.generate(**inputs)

        translated = step_tokenizer.batch_decode(outputs, skip_special_tokens=True)
        translated_text = translated[0].strip()

    return translated_text


def romanize(text: str, translate_language_code: str) -> str:
    """
    Function to romanize a given language string (if applicable)
    Note romanization is language-specific. For now, support only East Asian languages ("ko", "ja", "zh")

    Args:
        text: String input of the text to romanize
        translate_language_code: String input of the language to romanize from (e.g. "en", "ko")
    Returns:
        Romanized text string
    """
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

        result = pinyin(text, style=Style.TONE, v_to_u=True, errors="ignore")
        result = " ".join([item[0] for item in result])
        return result

    else:
        return ""


if __name__ == "__main__":
    print(romanize("미칠듯 사랑했던 기억이\n 추억들이 너를 찾고 있지만", "ko"))
    print(romanize("誰說太陽會找到月亮\n 別人有的愛 我們不可能模仿", "zh"))
    print(
        romanize(
            "愛に傷ついた あの日からずっと\n 昼と夜が逆の 暮らしを続けて\n はやりのDiscoで 踊り明かすうちに",
            "ja",
        )
    )

    init("ko", "en")
    print(translate("미칠듯 사랑했던 기억이\n 추억들이 너를 찾고 있지만"))

    init("ko", "zh")
    print(translate("미칠듯 사랑했던 기억이\n 추억들이 너를 찾고 있지만"))

    init("ja", "en")
    print(
        translate(
            "愛に傷ついた あの日からずっと\n 昼と夜が逆の 暮らしを続けて\n はやりのDiscoで 踊り明かすうちに"
        )
    )

    init("zh", "en")
    print(translate("誰說太陽會找到月亮\n 別人有的愛 我們不可能模仿"))
