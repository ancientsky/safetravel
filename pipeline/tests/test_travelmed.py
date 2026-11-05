from pipeline import travelmed


def test_check_header_rows_and_encoding():
    good = "醫事機構代碼,合約醫院名稱,所在縣市\n0101090517,臺大醫院,臺北市\n".encode("utf-8-sig")
    assert travelmed.check(good, ["醫事機構代碼", "所在縣市"], 1) == (1, None)
    n, problem = travelmed.check(good, ["醫事機構代碼", "星期"], 1)
    assert "星期" in problem
    n, problem = travelmed.check(good, ["醫事機構代碼"], 5)
    assert n == 1 and "only 1 rows" in problem
    big5 = "疾病,疫苗\nA,B\n".encode("cp950")
    assert travelmed.check(big5, ["疾病", "疫苗"], 1) == (1, None)
    assert travelmed.check(b"", ["x"], 1)[1] == "empty file"
