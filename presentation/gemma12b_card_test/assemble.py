#!/usr/bin/env python3
"""Merge completed runs, with later runs replacing individual cards."""

import argparse
from pathlib import Path

import run


def assemble(sources, out, include_partial=False):
    combined, provenance, records = {}, {}, []
    case = reference = detail = identity = None
    for directory in sources:
        directory = Path(directory).resolve()
        manifest = run.read_json(directory / "manifest.json")
        if manifest["status"] != "completed" and not (include_partial and manifest["status"] in ("failed", "interrupted")):
            raise ValueError(f"완료되지 않은 실행입니다: {directory}")
        current_case = run.read_json(directory / "case.json")
        current_reference = run.read_json(directory / "reference.json")
        current_identity = (manifest["model"], manifest["installed_model"]["digest"])
        if records and (current_case != case or current_reference != reference or manifest["detail"] != detail or current_identity != identity):
            raise ValueError("서로 다른 사례·참고 예시·상세도·모델을 합칠 수 없습니다.")
        case, reference, detail, identity = current_case, current_reference, manifest["detail"], current_identity
        if manifest["status"] == "completed":
            result = run.read_json(directory / "result.json")
        else:
            result = {"cards": [run.read_json(directory / "cards" / f"{s}.json")
                                for s in run.SECTIONS if (directory / "cards" / f"{s}.json").exists()]}
        run.validate_case(case)
        for card in result["cards"]:
            section = card["section"]
            if section not in run.SECTIONS:
                raise ValueError(f"알 수 없는 카드입니다: {section}")
            card_path = directory / "cards" / f"{section}.json"
            if run.read_json(card_path) != card:
                raise ValueError(f"최종 결과와 카드 파일이 다릅니다: {card_path}")
            combined[section] = card
            provenance[section] = str(card_path)
        records.append({"path": str(directory), "manifest": manifest})
    if set(combined) != set(run.SECTIONS):
        raise ValueError("최종 결과에 5개 카드가 모두 필요합니다.")
    cards = [combined[s] for s in run.SECTIONS]
    ids = run.validate_case(case)
    for card in cards:
        run.validate_card(card, card["section"], detail, ids)
    references = {c["section"]: c for c in reference["cards"]}
    evaluation = run.evaluate(cards, references, detail)
    out = Path(out).resolve()
    out.mkdir(parents=True, exist_ok=False)
    run.write_json(out / "case.json", case)
    run.write_json(out / "reference.json", reference)
    run.write_json(out / "result.json", {"model": identity[0], "detail": detail, "cards": cards})
    run.write_json(out / "evaluation.json", evaluation)
    run.write_report(out, cards, references, evaluation)
    run.write_json(out / "manifest.json", {
        "status": "completed", "mode": "assembled", "model": identity[0], "detail": detail,
        "all_five_selected": True, "source_cards": provenance, "source_runs": records,
    })
    return out


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("sources", type=Path, nargs="+")
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--include-partial", action="store_true", help="실패/중단된 실행에서 완료된 최종 카드만 사용")
    args = parser.parse_args()
    try:
        print(assemble(args.sources, args.out, args.include_partial))
    except (OSError, ValueError, KeyError, TypeError) as exc:
        parser.exit(1, f"합치기 실패: {exc}\n")
