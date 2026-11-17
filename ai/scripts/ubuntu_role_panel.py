"""CPU-only deterministic role evaluation helpers; never performs inference.

JSON shape against a reference is a surrogate, not formal schema validation.
Exact fields measure literal agreement only, never clinical or paraphrase quality.
"""
import hashlib
import json
import math
from collections import defaultdict


def _hash(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False,
                                     separators=(",", ":")).encode()).hexdigest()


def _id(row):
    value = row.get("sample_id", row.get("id"))
    if value is None or str(value) == "":
        raise ValueError("missing sample_id/id")
    return str(value)


def _root(row):
    for key in ("source_group_id", "root_group", "source_root", "source_group", "root_id", "source_case_id"):
        if row.get(key) is not None:
            return str(row[key])
    roots = row.get("source_root_ids", row.get("source_roots"))
    return _hash(sorted(map(str, roots))) if roots else None


def build_generation_selection(rows, per_task=16):
    """Return task -> original row indices, independent of model/reference text.

    Stratify known source groups by round robin. Missing lineage remains selectable
    but cannot support a source-group uncertainty interval. No raw text is hashed.
    """
    if not isinstance(per_task, int) or isinstance(per_task, bool) or per_task < 1:
        raise ValueError("per_task must be positive integer")
    tasks, seen = defaultdict(lambda: defaultdict(list)), set()
    for index, row in enumerate(rows):
        if row.get("split", "validation") != "validation":
            raise ValueError("generation selection requires validation rows")
        task, sid = row.get("task"), _id(row)
        if not isinstance(task, str) or not task:
            raise ValueError("missing task")
        if (task, sid) in seen:
            raise ValueError("duplicate task/sample_id")
        seen.add((task, sid))
        root = _root(row)
        tasks[task][root or ("unknown:" + sid)].append(( _hash([task, sid]), index))
    selected = {}
    for task, groups in sorted(tasks.items()):
        queues = [sorted(groups[k]) for k in sorted(groups, key=lambda k: _hash([task, k]))]
        result = []
        while len(result) < per_task and any(queues):
            for queue in queues:
                if queue and len(result) < per_task:
                    result.append(queue.pop(0)[1])
        selected[task] = result
    return selected


def _parse(text):
    def pairs(items):
        out = {}
        for key, value in items:
            if key in out:
                raise ValueError("duplicate JSON key")
            out[key] = value
        return out
    def constant(value):
        raise ValueError("nonfinite JSON number")
    def finite_float(value):
        number = float(value)
        if not math.isfinite(number):
            raise ValueError("nonfinite JSON number")
        return number
    return json.loads(text, object_pairs_hook=pairs, parse_constant=constant, parse_float=finite_float)


def _shape(value, gold):
    if type(value) is not type(gold):
        return False
    if isinstance(gold, dict):
        return value.keys() == gold.keys() and all(_shape(value[k], v) for k, v in gold.items())
    if isinstance(gold, list):
        # A single gold list cannot define arbitrary union/item schemas. Preserve
        # exact cardinality and positional types as an explicitly strict surrogate.
        return len(value) == len(gold) and all(_shape(a, b) for a, b in zip(value, gold))
    return True


def _walk_gold(value, prefix=()):
    if isinstance(value, dict):
        for key, child in value.items():
            yield prefix + (key,), child
            yield from _walk_gold(child, prefix + (key,))
    elif isinstance(value, list):
        for i, child in enumerate(value):
            yield from _walk_gold(child, prefix + (i,))


def _at(value, path):
    try:
        for part in path:
            value = value[part]
        return value
    except (KeyError, IndexError, TypeError):
        return None


def score_generation(task, generated_text, reference_text):
    result = {"task": task, "strict_json_valid": False, "typed_shape_surrogate": None,
              "shape_is_formal_schema": False, "content_exact": generated_text == reference_text,
              "approved_comparisons": [], "issue_code_comparisons": [],
              "question_decision_exact": [], "fact_exact": [],
              "human_semantics": None, "clinical_quality": None}
    try:
        gold = _parse(reference_text)
    except (ValueError, TypeError):
        result["reference_kind"] = "text"
        result["strict_json_valid"] = None
        result["text_nonempty"] = isinstance(generated_text, str) and bool(generated_text.strip())
        return result
    result["reference_kind"] = "json"
    try:
        value = _parse(generated_text)
    except (ValueError, TypeError):
        value = None
    else:
        result["strict_json_valid"] = True
    result["typed_shape_surrogate"] = result["strict_json_valid"] and _shape(value, gold)
    result["content_exact"] = result["strict_json_valid"] and _shape(value, gold) and value == gold
    for path, expected in _walk_gold(gold):
        key = path[-1]
        actual = _at(value, path)
        if key == "approved" and type(expected) is bool:
            result["approved_comparisons"].append({"path": list(path), "gold": expected,
                "predicted": actual if type(actual) is bool else None})
        if key in ("code", "issue_code") and isinstance(expected, str) and any(
                str(p) in ("issues", "issue_codes", "violations") for p in path[:-1]):
            result["issue_code_comparisons"].append({"path": list(path), "match": actual == expected})
        if key == "issue_codes" and isinstance(expected, list) and all(isinstance(x, str) for x in expected):
            result["issue_code_comparisons"].append({"path": list(path), "match": actual == expected})
        if key in ("decision", "action", "ask", "skip", "question_id", "selected_question_ids") and "question" in task:
            result["question_decision_exact"].append({"path": list(path), "match": type(actual) is type(expected) and actual == expected})
        if key in ("facts", "observations", "slots") and isinstance(expected, (list, dict)):
            result["fact_exact"].append({"path": list(path), "match": type(actual) is type(expected) and actual == expected})
    return result


def _key(row):
    return str(row["model"]), str(row["task"]), _id(row)


def aggregate(records, assignments):
    expected = {_key(a): a for a in assignments}
    if len(expected) != len(assignments):
        raise ValueError("duplicate assignments")
    observed = {}
    for row in records:
        key = _key(row)
        if key not in expected or key in observed:
            raise ValueError("unassigned or duplicate outcome")
        observed[key] = row
    buckets = defaultdict(list)
    for key, assignment in expected.items():
        buckets[key[:2]].append((assignment, observed.get(key)))
    output = {}
    for (model, task), rows in sorted(buckets.items()):
        counts = {k: 0 for k in ("assigned", "completed", "failed", "outcap", "not_run", "strict_json_valid", "typed_shape_surrogate", "content_exact")}
        decisions, roots = [], set()
        submetrics = {k: {"compared_fields": 0, "matching_fields": 0} for k in
                      ("question_decision_exact", "fact_exact", "issue_code_comparisons")}
        json_applicable = text_applicable = text_nonempty = 0
        for assignment, row in rows:
            counts["assigned"] += 1
            root = _root(assignment)
            if root is not None:
                roots.add(root)
            if row is None or row.get("execution_status", row.get("status")) == "not_run":
                counts["not_run"] += 1
                continue
            status = row.get("execution_status", row.get("status", "completed"))
            if status not in ("output_received", "completed", "success", "ok", "failed", "error", "outcap", "output_cap"):
                raise ValueError("unknown outcome status")
            if status in ("outcap", "output_cap") or row.get("finish_reason") == "length":
                counts["outcap"] += 1
                continue
            if status in ("failed", "error"):
                counts["failed"] += 1
                continue
            counts["completed"] += 1
            score = row.get("scores", row.get("score", {}))
            json_applicable += int(score.get("reference_kind") == "json")
            text_applicable += int(score.get("reference_kind") == "text")
            text_nonempty += int(score.get("text_nonempty") is True)
            for field in ("strict_json_valid", "typed_shape_surrogate", "content_exact"):
                counts[field] += int(score.get(field) is True)
            decisions.extend(score.get("approved_comparisons", []))
            for metric, tally in submetrics.items():
                fields = score.get(metric, [])
                tally["compared_fields"] += len(fields)
                tally["matching_fields"] += sum(x.get("match") is True for x in fields)
        tp = sum(x["gold"] is True and x["predicted"] is True for x in decisions)
        fp = sum(x["gold"] is False and x["predicted"] is True for x in decisions)
        fn = sum(x["gold"] is True and x["predicted"] is not True for x in decisions)
        negatives = sum(x["gold"] is False for x in decisions)
        positives = sum(x["gold"] is True for x in decisions)
        output.setdefault(model, {})[task] = {**counts,
            "fixed_denominator_rates": {k: (None if k != "content_exact" and not json_applicable else counts[k] / counts["assigned"])
                                        for k in ("strict_json_valid", "typed_shape_surrogate", "content_exact")},
            "approval": {"observed_fields": len(decisions), "positive_gold": positives, "negative_gold": negatives,
                "f1": 2 * tp / (2 * tp + fp + fn) if positives and negatives else None,
                "invalid_or_missing_predictions": sum(type(x["predicted"]) is not bool for x in decisions),
                "normal_false_alarm_rate": sum(x["predicted"] is False for x in decisions if x["gold"] is True) / positives if positives else None,
                "coverage_scope": "identifiable approved fields of completed outputs only"},
            "json_reference_completed_count": json_applicable,
            "natural_text": {"reference_completed_count": text_applicable, "nonempty_count": text_nonempty,
                             "semantic_validity": None},
            "identifiable_field_exact": submetrics,
            "source_groups": len(roots), "descriptive_ci": None,
            "ci_null_reason": "No validated independent source-group bootstrap contract; missing lineage and shared source dependence are not assumed away.",
            "human_semantics": None, "clinical_quality": None}
    return output


def aggregate_ce(records):
    """Aggregate complete teacher-forced target CE only; never generated-token scores.

    Each record: model, task, row_ce (unweighted mean full target CE), weight
    (default 1), target_tokens, full_target=True. Failed rows retain denominator.
    """
    groups = defaultdict(list)
    seen = set()
    for source in records:
        row = dict(source)
        if "sample_id" in row or "id" in row:
            identity = _key(row)
            if identity in seen:
                raise ValueError("duplicate CE outcome")
            seen.add(identity)
        if "loss" in row:
            row["row_ce"] = row["loss"]
            row["target_tokens"] = row.get("target_length")
            row["full_target"] = row.get("execution_status") == "output_received"
            if "weighted_loss" in row:
                row["weighted_ce"] = row["weighted_loss"]
        groups[str(row["model"]), str(row["task"])].append(row)
    result = {}
    for (model, task), rows in sorted(groups.items()):
        valid = [r for r in rows if r.get("full_target") is True and isinstance(r.get("row_ce"), (int, float))
                 and not isinstance(r.get("row_ce"), bool) and math.isfinite(r["row_ce"]) and r["row_ce"] >= 0]
        for r in valid:
            if not isinstance(r.get("weight", 1), (int, float)) or not math.isfinite(r.get("weight", 1)) or r.get("weight", 1) < 0:
                raise ValueError("invalid CE weight")
        for r in valid:
            if "weighted_ce" in r and (type(r["weighted_ce"]) not in (int, float) or not math.isfinite(r["weighted_ce"]) or r["weighted_ce"] < 0):
                raise ValueError("invalid weighted CE")
        complete = len(valid) == len(rows)
        lengths = complete and all(type(r.get("target_tokens")) is int and r["target_tokens"] > 0 for r in valid)
        result.setdefault(model, {})[task] = {"assigned": len(rows), "valid_full_target_rows": len(valid),
            "weighted_row_ce": sum(r.get("weighted_ce", r.get("weight", 1) * r["row_ce"]) for r in valid) / len(rows) if complete else None,
            "microtoken_ce": sum(r["row_ce"] * r["target_tokens"] for r in valid) / sum(r["target_tokens"] for r in valid) if lengths else None,
            "null_reason": None if complete else "incomplete or invalid full-target losses; no partial mean substituted",
            "generation_quality_proxy": False}
    return result


def reportmarkdown(data):
    lines = ["# Ubuntu 역할별 모델 평가", "", "동일한 고정 validation 표본에서 역할별로 비교합니다. 학습 검증 분할 결과이며 독립 시험 성능으로 해석하지 않습니다.", "",
             "JSON 검사는 참조 출력의 키·자료형·배열 길이에 대한 엄격한 대리 검사입니다. 정식 앱 스키마 검증과 의미·임상 품질 평가는 별도이며 여기서는 측정하지 않습니다.", "",
             "CE는 전체 정답 토큰의 teacher-forced 손실만 집계하며 생성 품질 점수로 환산하지 않습니다. 정확 일치는 표현이 다른 정답도 불일치로 셉니다. 속도 순위나 종합 가중 점수는 산출하지 않습니다.", "",
             "| 모델 | 작업 | 배정 | 완료 | 실패 | 출력 한도 | 미실행 | JSON 통과 | 구조 대리 통과 |", "|---|---|---:|---:|---:|---:|---:|---:|---:|"]
    for model, tasks in sorted(data.get("generation", data).items()):
        if not isinstance(tasks, dict):
            continue
        for task, row in sorted(tasks.items()):
            if isinstance(row, dict) and "assigned" in row:
                labels = [str(model).replace("|", "\\|"), str(task).replace("|", "\\|")]
                lines.append("| " + " | ".join(labels + [str(row.get(k, 0)) for k in ("assigned", "completed", "failed", "outcap", "not_run", "strict_json_valid", "typed_shape_surrogate")]) + " |")
    lines += ["", "실패·출력 한도는 배정 분모에 남깁니다. 미실행과 구분하며, 검토 F1은 양쪽 정답 라벨이 관측된 식별 가능한 approved 필드에만 제공합니다. 원문·정답·생성 발화는 이 보고서에 포함하지 않습니다."]
    return "\n".join(lines) + "\n"
