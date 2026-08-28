{-# LANGUAGE OverloadedStrings #-}
{-# LANGUAGE ScopedTypeVariables #-}

-- | Parse and rank release tags.
module Poly.Release
  ( Release (..)
  , version
  , latest
  ) where

import           Data.List  (sortOn)
import qualified Data.Text  as T
import           Text.Read  (readMaybe)

data Release = Release
  { tag        :: T.Text
  , assets     :: [T.Text]
  , prerelease :: Bool
  } deriving (Eq, Show)

-- | @version "v0.2.0"@ yields @Just (0, 2, 0)@.
version :: T.Text -> Maybe (Int, Int, Int)
version t = case T.splitOn "." (T.dropWhile (== 'v') (T.takeWhile (/= '-') t)) of
  [a, b, c] -> (,,) <$> readInt a <*> readInt b <*> readInt c
  _         -> Nothing
  where
    readInt = readMaybe . T.unpack

latest :: [Release] -> Maybe Release
latest rs = case sortOn (version . tag) [r | r <- rs, not (prerelease r)] of
  [] -> Nothing
  xs -> Just (last xs)

describe :: Release -> T.Text
describe Release {tag = t, assets = as} =
  t <> " (" <> T.pack (show (length as)) <> " assets)"
