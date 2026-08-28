local M = {}

--- Greet a user by name.
function M.greet(name)
  if type(name) ~= "string" then
    return nil, "expected string"
  end
  return ("Hello, %s!"):format(name)
end

return M
