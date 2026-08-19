module MaskingExamples
  FIRST_DOC, SECOND_DOC = <<~FIRST, <<-'SECOND'
    class FakeHeredoc
      def fake_method
      end
    end
  FIRST
    describe "fake spec" do
    end
  SECOND

  WORDS = %w[class FakePercent end]
  REGEX = %r{fake_regex/end[0-9]+}

  # Regex literals and division must not desynchronize following methods.
  def normalized_ratio(total, count)
    matcher = /order\/end/i
    value = total / count
    return value if count.positive?
    0
  end

  def retryable?(attempt)
    attempt < 3 unless attempt.nil?
  end
end

=begin
class FakeComment
  def hidden
  end
end
=end

class VisibleAfterComment
  def visible
    true
  end
end
